import { USE_WASM } from '../const.js';
import { CpuProNode } from '../types.js';
import { CallTree, AncestorSubsetCallTree } from './call-tree.js';
import {
    BufferDictionaryMetricsMap,
    BufferDimensionMap,
    BufferMap,
    BufferSamplesMetricsMap,
    BufferTreeMetricsMap,
    ComputeMetricsApi,
    createJavaScriptApi,
    createWasmApi
} from './metrics-wasm-wrapper.js';

const computeMetricsJavaScriptApi = createJavaScriptApi();
const { computeTreeMetrics } = computeMetricsJavaScriptApi;

function binarySearch(array: Uint32Array, value: number): number {
    let left = 0;
    let right = array.length - 1;

    while (left <= right) {
        const mid = (left + right) >> 1;
        const midValue = array[mid];

        if (midValue === value) {
            return mid;
        }

        if (midValue < value) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return right === -1 ? 0 : right;
}

function computeCumulative(cumulative: Uint32Array, values: Uint32Array) {
    for (let i = 1; i < cumulative.length; i++) {
        cumulative[i] = values[i - 1] + cumulative[i - 1];
    }
}

function computeAll<T extends CpuProNode>(api: ComputeMetricsApi, bufferMap: BufferMap<T>, clear = true) {
    api.computeMetrics(bufferMap.samples, clear);

    for (const { treeMap: tree, dictMap: dict } of bufferMap.dimensions) {
        api.computeTreeMetrics(tree, clear);
        api.computeDictionaryMetrics(dict, clear);
    }
}

export type LineDimension<T extends CpuProNode> = {
    values: DictionaryMetrics<T>;
    valuesFiltered: DictionaryMetrics<T>;
    treeValues: TreeMetrics<T>;
    treeValuesFiltered: TreeMetrics<T>;
    treeValueBounds: TreeValueBounds<T>;
}

export type DictDimension<T extends CpuProNode> = {
    all: DictionaryMetrics<T>;
    filtered: DictionaryMetrics<T>;
}

export type TreeDimension<T extends CpuProNode> = {
    all: TreeMetrics<T>;
    filtered: TreeMetrics<T>;
    bounds: TreeValueBounds<T>;
}

export type Listener = { fn: () => void };
export class MetricsObserver {
    #subscriptions: Listener[] = [];

    subscribe(fn: () => void) {
        let listener: Listener | null = { fn };
        this.#subscriptions.push(listener);

        return () => {
            if (listener !== null) {
                this.#subscriptions = this.#subscriptions.filter(el => el !== listener);
                listener = null;
            }
        };
    }

    notify() {
        for (const { fn } of this.#subscriptions) {
            fn();
        }
    }
}

export class SamplesMetrics extends MetricsObserver {
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;
    samplesCount: Uint32Array;
    samplesTotal: Uint32Array;

    constructor(
        samples: Uint32Array,
        values: Uint32Array,
        cumulative: Uint32Array,
        samplesCount: Uint32Array,
        samplesTotal: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = cumulative;
        this.samplesCount = samplesCount;
        this.samplesTotal = samplesTotal;
    }
}

export class SamplesMetricsFiltered extends SamplesMetrics {
    samplesMask: Uint32Array;
    originalValues: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
    rangeSamples: number | null = null;

    constructor(
        samples: Uint32Array,
        samplesMask: Uint32Array,
        values: Uint32Array,
        cumulative: Uint32Array,
        samplesCount: Uint32Array,
        samplesTotal: Uint32Array
    ) {
        super(
            samples,
            values,
            cumulative,
            samplesCount,
            samplesTotal
        );

        this.samplesMask = samplesMask;
        this.originalValues = values;
    }

    resetRange() {
        this.rangeStart = null;
        this.rangeEnd = null;
        this.rangeSamples = null;

        if (this.values !== this.originalValues) {
            this.values.set(this.originalValues);
            this.originalValues = this.values;
        }

        this.notify();
    }

    setRange(start: number | null, end: number | null) {
        const { values, cumulative } = this;
        let { originalValues } = this;

        if (start === null || end === null) {
            this.resetRange();
            return;
        }

        if (values === originalValues) {
            // Store the state of values before the first changes to be able to fill it according
            // to filters or restore it. We can't replace values with its copy since it may be part
            // of Wasm memory, which is used by Wasm code for computations
            this.originalValues = originalValues = values.slice();
        }

        values.fill(0);

        const startIndex = binarySearch(cumulative, start);
        const endIndex = binarySearch(cumulative, end);

        this.rangeStart = start;
        this.rangeEnd = end;
        this.rangeSamples = endIndex - startIndex + 1;

        if (startIndex !== endIndex) {
            values[startIndex] = originalValues[startIndex] - (start - cumulative[startIndex]);
            values[endIndex] = end - cumulative[endIndex];

            if (startIndex + 1 < endIndex) {
                values.set(originalValues.subarray(startIndex + 1, endIndex), startIndex + 1);
            }
        } else {
            values[startIndex] = end - start;
        }

        this.notify();
    }
}

export class TreeMetrics<T extends CpuProNode> extends MetricsObserver {
    tree: CallTree<T>;
    samplesCount: Uint32Array;
    selfValues: Uint32Array;
    nestedValues: Uint32Array;

    constructor(
        tree: CallTree<T>,
        samplesCount: Uint32Array,
        selfValues: Uint32Array,
        nestedValues: Uint32Array
    ) {
        super();

        this.tree = tree;
        this.samplesCount = samplesCount;
        this.selfValues = selfValues;
        this.nestedValues = nestedValues;
    }

    getMetrics(index: number) {
        const samples = this.samplesCount[index];
        const selfValue = this.selfValues[index];
        const nestedValue = this.nestedValues[index];

        return {
            node: this.tree.getEntry(index),
            samples,
            selfValue,
            nestedValue,
            totalValue: selfValue + nestedValue
        };
    }

    getValueMetrics(valueIndex: number) {
        const { tree, samplesCount, selfValues, nestedValues } = this;
        const { nested } = tree;
        let samples = 0;
        let selfValue = 0;
        let nestedValue = 0;

        for (const index of tree.selectNodes(valueIndex, true)) {
            samples += samplesCount[index];
            selfValue += selfValues[index];
            if (nested[index] === 0) {
                nestedValue += nestedValues[index];
            }
        }

        return {
            value: tree.dictionary[valueIndex],
            samples,
            selfValue,
            nestedValue,
            totalValue: selfValue + nestedValue
        };
    }
}

// The SubsetTreeMetrics class is mostly the same as TreeMetrics, but works with subtrees.
// It uses tree's sampleIdToNode to land samples to existing nodes and the rest (sampleIdToNode[i] === -1)
// to a special (last) element in samplesCount/selfValues/nestedValues arrays.
export class SubsetTreeMetrics<T extends CpuProNode> extends TreeMetrics<T> {
    samplesMetrics: SamplesMetrics;

    constructor(tree: CallTree<T>, samplesMetrics: SamplesMetrics) {
        const size = tree.nodes.length + 1; // add extra element for excluded metrics

        super(
            tree,
            new Uint32Array(size),
            new Uint32Array(size),
            new Uint32Array(size)
        );

        this.samplesMetrics = samplesMetrics;
        this.subscribe = samplesMetrics.subscribe.bind(samplesMetrics);
        this.recompute(false);
    }

    get excludedMetrics() {
        const { samplesCount, selfValues, nestedValues } = this;
        const lastIndex = samplesCount.length - 1;

        return {
            samples: samplesCount[lastIndex],
            selfValue: selfValues[lastIndex],
            nestedValue: nestedValues[lastIndex],
            totalValue: selfValues[lastIndex] + nestedValues[lastIndex]
        };
    }

    recompute(clear = true) {
        computeTreeMetrics({
            tree: this.tree,
            sourceSamplesCount: this.samplesMetrics.samplesCount,
            sourceSamplesTotal: this.samplesMetrics.samplesTotal,
            sampleIdToNode: this.tree.sampleIdToNode,
            parent: this.tree.parent,
            samplesCount: this.samplesCount,
            selfValues: this.selfValues,
            nestedValues: this.nestedValues
        }, clear);
    }
}

// AncestorSubsetTreeMetrics computes metrics for an AncestorSubsetCallTree by
// reading values from the original tree's filtered metrics. Each node in the
// ancestor tree maps to one or more original tree nodes (via nodeOriginals).
// Values are summed across all originals, giving each ancestor the total time
// that flows through it toward the focused call frame.
export class AncestorSubsetTreeMetrics<T extends CpuProNode> extends TreeMetrics<T> {
    originalMetrics: TreeMetrics<T>;

    constructor(tree: AncestorSubsetCallTree<T>, originalMetrics: TreeMetrics<T>) {
        const size = tree.nodes.length + 1; // +1 for excluded slot (compatibility)

        super(
            tree,
            new Uint32Array(size),
            new Uint32Array(size),
            new Uint32Array(size)
        );

        this.originalMetrics = originalMetrics;
        this.subscribe = originalMetrics.subscribe.bind(originalMetrics);
        this.recompute();
    }

    recompute() {
        const { selfValues, nestedValues, samplesCount } = this;
        const origSelf = this.originalMetrics.selfValues;
        const origNested = this.originalMetrics.nestedValues;
        const origSamples = this.originalMetrics.samplesCount;
        const ancestorTree = this.tree as AncestorSubsetCallTree<T>;
        const { nodeOriginals, nodeOriginalsOffset, nodeOriginalsCount } = ancestorTree;
        const origNestedFlag = this.originalMetrics.tree.nested;

        selfValues.fill(0);
        nestedValues.fill(0);
        samplesCount.fill(0);

        for (let i = 0; i < nodeOriginalsCount.length; i++) {
            const start = nodeOriginalsOffset[i];
            const end = start + nodeOriginalsCount[i];
            for (let j = start; j < end; j++) {
                const origIdx = nodeOriginals[j];
                selfValues[i] += origSelf[origIdx];
                samplesCount[i] += origSamples[origIdx];
                // For nodes that are occurrences of the focused value (mapped to root),
                // skip nestedValues for recursive occurrences to avoid double-counting
                // (same logic as getValueMetrics)
                if (origNestedFlag[origIdx] === 0) {
                    nestedValues[i] += origNested[origIdx];
                }
            }
        }
    }
}

export type DictionaryMetric<T> = {
    entryIndex: number;
    entry: T;
    samples: number;
    selfValue: number;
    nestedValue: number;
    totalValue: number;
};

export class DictionaryMetrics<T extends CpuProNode> extends MetricsObserver {
    dictionary: T[];
    entries: DictionaryMetric<T>[];
    entriesMap: Map<T, DictionaryMetric<T>>;
    samplesCount: Uint32Array;
    selfValues: Uint32Array;
    totalValues: Uint32Array;

    constructor(
        dictionary: T[],
        samplesCount: Uint32Array,
        selfValues: Uint32Array,
        totalValues: Uint32Array
    ) {
        super();

        this.dictionary = dictionary;
        this.samplesCount = samplesCount;
        this.selfValues = selfValues;
        this.totalValues = totalValues;
        this.entries = dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            samples: samplesCount[entryIndex],
            selfValue: selfValues[entryIndex],
            nestedValue: totalValues[entryIndex] - selfValues[entryIndex],
            totalValue: totalValues[entryIndex]
        }));
        this.entriesMap = this.entries.reduce(
            (map, element) => map.set(element.entry, element),
            new Map()
        );
    }

    getEntry(sourceEntry: T): DictionaryMetric<T> | null {
        return this.entriesMap.get(sourceEntry) || null;
    }

    sync() {
        const { entries, samplesCount, selfValues, totalValues } = this;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const selfValue = selfValues[i];
            const totalValue = totalValues[i];

            entry.samples = samplesCount[i];
            entry.selfValue = selfValue;
            entry.nestedValue = totalValue - selfValue;
            entry.totalValue = totalValue;
        }
    }
}

export type DictionaryBounds<T> = {
    entryIndex: number;
    entry: T;
    firstSeen: number;
    lastSeen: number;
};

export class TreeValueBounds<T extends CpuProNode> {
    entries: DictionaryBounds<T>[];
    entriesMap: Map<T, DictionaryMetric<T>>;
    firstSeen: Uint32Array;
    lastSeen: Uint32Array;

    constructor(tree: CallTree<T>, cumulative: Uint32Array, samples: Uint32Array) {
        const { dictionary, nodes, parent, sampleIdToNode } = tree;
        const firstSeen = new Uint32Array(nodes.length).fill(0xffffffff);
        const lastSeen = new Uint32Array(nodes.length);
        const firstSeenDict = new Uint32Array(dictionary.length).fill(0xffffffff);
        const lastSeenDict = new Uint32Array(dictionary.length);

        for (let i = 0; i < samples.length; i++) {
            const nodeId = sampleIdToNode[samples[i]];
            const position = cumulative[i];

            if (firstSeen[nodeId] > position) {
                firstSeen[nodeId] = position;
            }

            if (lastSeen[nodeId] < position) {
                lastSeen[nodeId] = position;
            }
        }

        for (let i = nodes.length - 1; i > 0; i--) {
            const parentId = parent[i];
            const dictId = nodes[i];
            const fs = firstSeen[i];
            const ls = lastSeen[i];

            if (firstSeen[parentId] > fs) {
                firstSeen[parentId] = fs;
            }

            if (firstSeenDict[dictId] > fs) {
                firstSeenDict[dictId] = fs;
            }

            if (lastSeen[parentId] < ls) {
                lastSeen[parentId] = ls;
            }

            if (lastSeenDict[dictId] < ls) {
                lastSeenDict[dictId] = ls;
            }
        }

        this.firstSeen = firstSeen;
        this.lastSeen = lastSeen;

        this.entries = dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            firstSeen: firstSeenDict[entryIndex],
            lastSeen: lastSeenDict[entryIndex]
        }));
        this.entriesMap = this.entries.reduce(
            (map, element) => map.set(element.entry, element),
            new Map()
        );
    }
}

function createMapsFromTree<T>(tree: CallTree<T>) {
    const { nodes, nested, sampleIdToNode } = tree;
    const totalNodes = new Uint32Array(nodes.length);
    const totalNodeToDict = new Uint32Array(nodes.length);
    let k = 0;

    for (let i = 0; i < nodes.length; i++) {
        if (nested[i] === 0) {
            totalNodeToDict[k] = nodes[i];
            totalNodes[k] = i;
            k++;
        }
    }

    return {
        tree,
        sampleIdToDict: sampleIdToNode.map(id => nodes[id]),
        totalNodes: totalNodes.slice(0, k),
        totalNodeToDict: totalNodeToDict.slice(0, k)
    };
}

function createTreeComputeBuffer<T>(
    samples: Uint32Array,
    values: Uint32Array,
    trees: CallTree<T>[],
    useWasm = true
) {
    const maps = trees.map(createMapsFromTree);

    // estimate buffer size
    const samplesMapSize = trees[0].sampleIdToNode.length;
    let bufferSize =
        // values
        // cumulative
        2 * values.length +
        // samples
        samples.length +
        // samplesMask
        // samplesCount
        // samplesTotal
        3 * samplesMapSize;

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        // tree metrics
        bufferSize +=
            // sampleIdToNode
            tree.sampleIdToNode.length +
            // parent
            tree.parent.length +
            // samplesCount
            // selfValues
            // nestedValues
            3 * tree.nodes.length;

        // dict metrics
        bufferSize +=
            sampleIdToDict.length +
            totalNodes.length +
            totalNodeToDict.length +
            // samplesCount
            // selfValues
            // totalValues
            3 * tree.dictionary.length;
    }

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize);
    const buffer = memory ? new Uint32Array(memory.buffer) : null;
    let bufferOffset = 0;
    const samplesMap: BufferSamplesMetricsMap = {
        values: adopt(values),
        cumulative: alloc(values.length),
        samples: adopt(samples),
        samplesMask: alloc(samplesMapSize),
        samplesCount: alloc(samplesMapSize),
        samplesTotal: alloc(samplesMapSize)
    };
    const bufferMap: BufferMap<T> = {
        memory,
        samples: samplesMap,
        dimensions: []
    };

    computeCumulative(samplesMap.cumulative, samplesMap.values);

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        const treeMap: BufferTreeMetricsMap<T> = {
            tree,
            sourceSamplesCount: samplesMap.samplesCount,
            sourceSamplesTotal: samplesMap.samplesTotal,
            sampleIdToNode: tree.sampleIdToNode = adopt(tree.sampleIdToNode),
            parent: adopt(tree.parent),
            samplesCount: alloc(tree.nodes.length),
            selfValues: alloc(tree.nodes.length),
            nestedValues: alloc(tree.nodes.length)
        };
        const dictMap: BufferDictionaryMetricsMap<T> = {
            dictionary: tree.dictionary,
            sourceSamplesCount: samplesMap.samplesCount,
            sourceSamplesTotal: samplesMap.samplesTotal,
            nodeSelfValues: treeMap.selfValues,
            nodeNestedValues: treeMap.nestedValues,
            sampleIdToDict: adopt(sampleIdToDict),
            totalNodes: adopt(totalNodes),
            totalNodeToDict: adopt(totalNodeToDict),
            samplesCount: alloc(tree.dictionary.length),
            selfValues: alloc(tree.dictionary.length),
            totalValues: alloc(tree.dictionary.length)
        };

        bufferMap.dimensions.push({ treeMap: treeMap, dictMap: dictMap });
    }

    return bufferMap;

    function adopt(array: Uint32Array) {
        if (buffer === null) {
            return array;
        }

        buffer.set(array, bufferOffset);

        return buffer.subarray(bufferOffset, bufferOffset += array.length);
    }

    function alloc(size: number) {
        if (buffer === null) {
            return new Uint32Array(size);
        }

        return buffer.subarray(bufferOffset, bufferOffset += size);
    }
}

function createDimension<T extends CpuProNode>(
    dimensionMaps: BufferDimensionMap<T>,
    samplesMap: BufferSamplesMetricsMap
): { dict: DictDimension<T>; tree: TreeDimension<T> } {
    const { treeMap, dictMap } = dimensionMaps;
    const dictAll = new DictionaryMetrics<T>(
        dictMap.dictionary,
        dictMap.samplesCount.slice(),
        dictMap.selfValues.slice(),
        dictMap.totalValues.slice()
    );
    const dictFiltered = new DictionaryMetrics(
        dictMap.dictionary,
        dictMap.samplesCount,
        dictMap.selfValues,
        dictMap.totalValues
    );
    const treeAll = new TreeMetrics(
        treeMap.tree,
        treeMap.samplesCount.slice(),
        treeMap.selfValues.slice(),
        treeMap.nestedValues.slice()
    );
    const treeFiltered = new TreeMetrics(
        treeMap.tree,
        treeMap.samplesCount,
        treeMap.selfValues,
        treeMap.nestedValues
    );
    const treeBounds = new TreeValueBounds(
        treeMap.tree,
        samplesMap.cumulative,
        samplesMap.samples
    );

    return {
        dict: {
            all: dictAll,
            filtered: dictFiltered
        },
        tree: {
            all: treeAll,
            filtered: treeFiltered,
            bounds: treeBounds
        }
    };
}

export function computeMetrics<T extends readonly CallTree<CpuProNode>[]>(
    samples: Uint32Array,
    values: Uint32Array,
    trees: [...T]
) {
    const useWasm = USE_WASM;
    const bufferMap = createTreeComputeBuffer(samples, values, trees, useWasm);
    const {
        memory,
        samples: samplesMap,
        dimensions: dimensionMaps
    } = bufferMap;
    const computeMetricsApi = useWasm && memory
        ? createWasmApi(memory)
        : computeMetricsJavaScriptApi;

    computeAll(computeMetricsApi, bufferMap, false);

    const samplesMetrics = new SamplesMetrics(
        samples,
        values,
        samplesMap.cumulative,
        samplesMap.samplesCount.slice(),
        samplesMap.samplesTotal.slice()
    );
    const samplesMetricsFiltered = new SamplesMetricsFiltered(
        samplesMap.samples,
        samplesMap.samplesMask,
        samplesMap.values,
        samplesMap.cumulative,
        samplesMap.samplesCount,
        samplesMap.samplesTotal
    );

    // Build dimensions with dict/tree separation
    const dimensionsWithStructure = dimensionMaps.map(maps =>
        createDimension(maps, samplesMap)
    );

    // Recompute metrics function
    const recomputeMetrics = () => {
        for (const { treeMap, dictMap } of dimensionMaps) {
            const { sampleIdToNode, tree: { nodes, sampleIdToNodeChanged } } = treeMap;
            const { sampleIdToDict } = dictMap;

            if (sampleIdToNodeChanged) {
                for (let j = 0; j < sampleIdToNode.length; j++) {
                    sampleIdToDict[j] = nodes[sampleIdToNode[j]];
                }

                // FIXME: temporary solution to avoid unnecessary dict recalculations
                treeMap.tree.sampleIdToNodeChanged = false;
            }
        }

        computeAll(computeMetricsApi, bufferMap);

        for (const dimension of dimensionsWithStructure) {
            dimension.tree.filtered.notify();
            dimension.dict.filtered.sync();
            dimension.dict.filtered.notify();
        }
    };

    // Recompute metrics on samples filter change
    samplesMetricsFiltered.subscribe(recomputeMetrics);

    return {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dimensions: dimensionsWithStructure
    };
}
