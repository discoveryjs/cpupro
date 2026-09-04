import { USE_WASM } from '../const.js';
import { Observer } from './misc.js';
import { CpuProNode } from '../types.js';
import { CallTree, AncestorSubsetCallTree } from './call-tree.js';
import {
    BufferDictionaryMetricsMap,
    BufferDimensionMap,
    MetricsBufferMap,
    BufferTreeMetricsMap,
    ComputeApi,
    createJavaScriptApi,
    createWasmApi
} from './compute-wasm-wrapper.js';
import { Population, PopulationFiltered } from './population.js';

const computeJavaScriptApi = createJavaScriptApi();
const { computeTreeMetrics } = computeJavaScriptApi;

function computeAll<T extends CpuProNode>(
    api: ComputeApi,
    bufferMap: MetricsBufferMap<T>,
    population: Population | PopulationFiltered,
    clear = true
) {
    bufferMap.samplesCount.set(population.samplesCount);
    bufferMap.samplesTotal.set(population.samplesTotal);

    for (const { treeMap: tree, dictMap: dict } of bufferMap.dimensions) {
        api.computeTreeMetrics(tree, clear);
        api.computeDictionaryMetrics(dict, clear);
    }
}

export type DictDimension<T extends CpuProNode> = {
    all: DictionaryMetrics<T>;
    filtered: DictionaryMetrics<T>;
}

export type TreeDimension<T extends CpuProNode> = {
    all: TreeMetrics<T>;
    filtered: TreeMetrics<T>;
}

export type SampledTree<T> = {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
};

export class TreeMetrics<T extends CpuProNode> extends Observer {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Uint32Array;
    nestedValues: Uint32Array;

    constructor(
        tree: CallTree<T>,
        sampleToNode: Uint32Array,
        samplesCount: Uint32Array,
        selfValues: Uint32Array,
        nestedValues: Uint32Array
    ) {
        super();

        this.tree = tree;
        this.sampleToNode = sampleToNode;
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

function projectSampleToNode<T extends CpuProNode>(tree: CallTree<T>, sourceMetrics: TreeMetrics<T>) {
    if (tree === sourceMetrics.tree) {
        return sourceMetrics.sampleToNode;
    }

    if (tree.sourceTree !== sourceMetrics.tree) {
        throw new Error('Unable to project samples: tree source does not match source metrics tree');
    }

    const sampleToNode = new Uint32Array(sourceMetrics.sampleToNode.length);
    const excludedNode = tree.nodes.length;

    for (let i = 0; i < sampleToNode.length; i++) {
        const nodeIndex = tree.sourceIdToNode[sourceMetrics.sampleToNode[i]];

        sampleToNode[i] = nodeIndex >= 0 ? nodeIndex : excludedNode;
    }

    return sampleToNode;
}

// The SubsetTreeMetrics class is mostly the same as TreeMetrics, but works with subtrees.
// It uses sampleToNode to land samples to existing nodes and the rest
// to a special (last) element in samplesCount/selfValues/nestedValues arrays.
export class SubsetTreeMetrics<T extends CpuProNode> extends TreeMetrics<T> {
    population: Population | PopulationFiltered;

    constructor(tree: CallTree<T>, population: Population | PopulationFiltered, sourceMetrics: TreeMetrics<T>) {
        const size = tree.nodes.length + 1; // add extra element for excluded metrics
        const sampleToNode = projectSampleToNode(tree, sourceMetrics);

        super(
            tree,
            sampleToNode,
            new Uint32Array(size),
            new Uint32Array(size),
            new Uint32Array(size)
        );

        this.population = population;
        this.subscribe = this.population.subscribe.bind(this.population);
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
            sourceSamplesCount: this.population.samplesCount,
            sourceSamplesTotal: this.population.samplesTotal,
            sampleToNode: this.sampleToNode,
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
            projectSampleToNode(tree, originalMetrics),
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

export class DictionaryMetrics<T extends CpuProNode> extends Observer {
    dictionary: T[];
    entries: DictionaryMetric<T>[];
    #entriesMap: WeakRef<Map<T, DictionaryMetric<T>>>;
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

        this.entries = this.dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            samples: samplesCount[entryIndex],
            selfValue: selfValues[entryIndex],
            nestedValue: totalValues[entryIndex] - selfValues[entryIndex],
            totalValue: totalValues[entryIndex]
        }));
    }

    get entriesMap() {
        let map = this.#entriesMap?.deref();

        if (map === undefined) {
            this.#entriesMap = new WeakRef(map = this.entries.reduce(
                (map, element) => map.set(element.entry, element),
                new Map()
            ));
        }

        return map;
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

function createMapsFromTree<T>(sampledTree: SampledTree<T>) {
    const { tree, sampleToNode } = sampledTree;
    const { nodes, nested } = tree;
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
        sampleToNode,
        sampleIdToDict: sampleToNode.map(id => nodes[id]),
        totalNodes: totalNodes.slice(0, k),
        totalNodeToDict: totalNodeToDict.slice(0, k)
    };
}

function createSampleBreakdownBuffer<T>(
    trees: SampledTree<T>[],
    samplesMapSize: number,
    useWasm = true
) {
    const maps = trees.map(createMapsFromTree);

    // estimate buffer size
    let bufferSize =
        // samplesCount
        // samplesTotal
        2 * samplesMapSize;

    for (const { tree, sampleToNode, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        // tree metrics
        bufferSize +=
            // sample-to-node map
            sampleToNode.length +
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
    const bufferMap: MetricsBufferMap<T> = {
        memory,
        samplesCount: alloc(samplesMapSize),
        samplesTotal: alloc(samplesMapSize),
        dimensions: []
    };

    for (const { tree, sampleToNode, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        const treeMap: BufferTreeMetricsMap<T> = {
            // input
            sourceSamplesCount: bufferMap.samplesCount,
            sourceSamplesTotal: bufferMap.samplesTotal,
            // compute support
            tree,
            sampleToNode: adopt(sampleToNode),
            parent: adopt(tree.parent),
            // output
            samplesCount: alloc(tree.nodes.length),
            selfValues: alloc(tree.nodes.length),
            nestedValues: alloc(tree.nodes.length)
        };
        const dictMap: BufferDictionaryMetricsMap<T> = {
            // input
            sourceSamplesCount: bufferMap.samplesCount,
            sourceSamplesTotal: bufferMap.samplesTotal,
            // compute support
            dictionary: tree.dictionary,
            nodeSelfValues: treeMap.selfValues,     // input from treeMap layer
            nodeNestedValues: treeMap.nestedValues, // input from treeMap layer
            sampleIdToDict: adopt(sampleIdToDict),
            totalNodes: adopt(totalNodes),
            totalNodeToDict: adopt(totalNodeToDict),
            // output
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
    dimensionMaps: BufferDimensionMap<T>
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
        treeMap.sampleToNode,
        treeMap.samplesCount.slice(),
        treeMap.selfValues.slice(),
        treeMap.nestedValues.slice()
    );
    const treeFiltered = new TreeMetrics(
        treeMap.tree,
        treeMap.sampleToNode,
        treeMap.samplesCount,
        treeMap.selfValues,
        treeMap.nestedValues
    );

    return {
        dict: {
            all: dictAll,
            filtered: dictFiltered
        },
        tree: {
            all: treeAll,
            filtered: treeFiltered
        }
    };
}

export function createSampleBreakdown<T extends readonly SampledTree<CpuProNode>[]>(
    population: PopulationFiltered,
    trees: [...T]
) {
    const useWasm = USE_WASM;
    const bufferMap = createSampleBreakdownBuffer(trees, population.samplesTotal.length, useWasm);
    const { memory, dimensions } = bufferMap;
    const computeApi = useWasm && memory
        ? createWasmApi(memory)
        : computeJavaScriptApi;

    computeAll(computeApi, bufferMap, population, false);

    // Build dimensions with dict/tree separation
    const dimensionsWithStructure = dimensions.map(maps =>
        createDimension(maps)
    );

    const recomputeMetrics = () => {
        computeAll(computeApi, bufferMap, population, true);

        for (const dimension of dimensionsWithStructure) {
            dimension.tree.filtered.notify();
            dimension.dict.filtered.sync();
            dimension.dict.filtered.notify();
        }
    };

    // Recompute metrics on samples filter change
    population.subscribe(recomputeMetrics);

    return {
        recomputeMetrics,
        dimensions: dimensionsWithStructure
    };
}
