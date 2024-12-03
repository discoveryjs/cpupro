import { USE_WASM } from '../const.js';
import { CpuProNode } from '../types.js';
import { CallTree } from './call-tree.js';
import {
    BufferDictionaryTimingsMap,
    BufferMap,
    BufferSamplesTimingsMap,
    BufferTreeTimingsMap,
    ComputeTimingsApi,
    createJavaScriptApi,
    createWasmApi
} from './timings-wasm-wrapper.js';

const computeTimingsJavaScriptApi = createJavaScriptApi();
const { computeTreeTimings } = computeTimingsJavaScriptApi;

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

function computeTimestamps(timestamps: Uint32Array, timeDeltas: Uint32Array) {
    for (let i = 1; i < timestamps.length; i++) {
        timestamps[i] = timeDeltas[i - 1] + timestamps[i - 1];
    }
}

function computeAll<T extends CpuProNode>(api: ComputeTimingsApi, bufferMap: BufferMap<T>, clear = true) {
    api.computeTimings(bufferMap.samples, clear);

    for (const treeMap of bufferMap.tree) {
        api.computeTreeTimings(treeMap, clear);
    }

    for (const dictMap of bufferMap.dict) {
        api.computeDictionaryTimings(dictMap, clear);
    }
}

export type Listener = { fn: () => void };
export class TimingsObserver {
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

export class SamplesTimings extends TimingsObserver {
    samples: Uint32Array;
    timeDeltas: Uint32Array;
    timestamps: Uint32Array;
    samplesCount: Uint32Array;
    samplesTimes: Uint32Array;

    constructor(
        samples: Uint32Array,
        timeDeltas: Uint32Array,
        timestamps: Uint32Array,
        samplesCount: Uint32Array,
        samplesTimes: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.timeDeltas = timeDeltas;
        this.timestamps = timestamps;
        this.samplesCount = samplesCount;
        this.samplesTimes = samplesTimes;
    }
}

export class SamplesTimingsFiltered extends SamplesTimings {
    samplesMask: Uint32Array;
    originalTimeDeltas: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
    rangeSamples: number | null = null;

    constructor(
        samples: Uint32Array,
        samplesMask: Uint32Array,
        timeDeltas: Uint32Array,
        timestamps: Uint32Array,
        samplesCount: Uint32Array,
        samplesTimes: Uint32Array
    ) {
        super(
            samples,
            timeDeltas,
            timestamps,
            samplesCount,
            samplesTimes
        );

        this.samplesMask = samplesMask;
        this.originalTimeDeltas = timeDeltas;
    }

    resetRange() {
        this.rangeStart = null;
        this.rangeEnd = null;
        this.rangeSamples = null;

        if (this.timeDeltas !== this.originalTimeDeltas) {
            this.timeDeltas.set(this.originalTimeDeltas);
            this.originalTimeDeltas = this.timeDeltas;
        }
    }
    setRange(start: number, end: number) {
        const { timeDeltas, timestamps } = this;
        let { originalTimeDeltas } = this;

        if (timeDeltas === originalTimeDeltas) {
            // Store the state of timeDeltas before the first changes to be able to fill it according
            // to filters or restore it. We can't replace timeDeltas with its copy since it may be part
            // of Wasm memory, which is used by Wasm code for computations
            this.originalTimeDeltas = originalTimeDeltas = timeDeltas.slice();
        }

        timeDeltas.fill(0);

        const startIndex = binarySearch(timestamps, start);
        const endIndex = binarySearch(timestamps, end);

        this.rangeStart = start;
        this.rangeEnd = end;
        this.rangeSamples = endIndex - startIndex + 1;

        if (startIndex !== endIndex) {
            timeDeltas[startIndex] = originalTimeDeltas[startIndex] - (start - timestamps[startIndex]);
            timeDeltas[endIndex] = end - timestamps[endIndex];

            if (startIndex + 1 < endIndex) {
                timeDeltas.set(originalTimeDeltas.subarray(startIndex + 1, endIndex), startIndex + 1);
            }
        } else {
            timeDeltas[startIndex] = end - start;
        }

        // let sum = timeDeltas.reduce((s, i) => s + i, 0);
        // console.log('setRange', Date.now() - t, {start, end}, startIndex, endIndex, { range: end - start, sum });
    }
}

export class TreeTimings<T extends CpuProNode> extends TimingsObserver {
    tree: CallTree<T>;
    samplesCount: Uint32Array;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(
        tree: CallTree<T>,
        samplesCount: Uint32Array,
        selfTimes: Uint32Array,
        nestedTimes: Uint32Array
    ) {
        super();

        this.tree = tree;
        this.samplesCount = samplesCount;
        this.selfTimes = selfTimes;
        this.nestedTimes = nestedTimes;
    }

    getTimings(index: number) {
        const samples = this.samplesCount[index];
        const selfTime = this.selfTimes[index];
        const nestedTime = this.nestedTimes[index];

        return {
            node: this.tree.getEntry(index),
            samples,
            selfTime,
            nestedTime,
            totalTime: selfTime + nestedTime
        };
    }

    getValueTimings(valueIndex: number) {
        const { tree, samplesCount, selfTimes, nestedTimes } = this;
        const { nested } = tree;
        let samples = 0;
        let selfTime = 0;
        let nestedTime = 0;

        for (const index of tree.selectNodes(valueIndex, true)) {
            samples += samplesCount[index];
            selfTime += selfTimes[index];
            if (nested[index] === 0) {
                nestedTime += nestedTimes[index];
            }
        }

        return {
            value: tree.dictionary[valueIndex],
            samples,
            selfTime,
            nestedTime,
            totalTime: selfTime + nestedTime
        };
    }
}

// The SubsetTreeTimings class is mostly the same as TreeTimings, but works with subtrees.
// It uses tree's sampleIdToNode to land samples to existing nodes and the rest (sampleIdToNode[i] === -1)
// to a special (last) element in samplesCount/selfTimes/nestedTimes arrays.
export class SubsetTreeTimings<T extends CpuProNode> extends TreeTimings<T> {
    samplesTimings: SamplesTimings;

    constructor(tree: CallTree<T>, samplesTimings: SamplesTimings) {
        const size = tree.nodes.length + 1; // add extra element for excluded timings

        super(
            tree,
            new Uint32Array(size),
            new Uint32Array(size),
            new Uint32Array(size)
        );

        this.samplesTimings = samplesTimings;
        this.subscribe = samplesTimings.subscribe.bind(samplesTimings);
        this.recompute(false);
    }

    get excludedTimings() {
        const { samplesCount, selfTimes, nestedTimes } = this;
        const lastIndex = samplesCount.length - 1;

        return {
            samples: samplesCount[lastIndex],
            selfTime: selfTimes[lastIndex],
            nestedTime: nestedTimes[lastIndex],
            totalTime: selfTimes[lastIndex] + nestedTimes[lastIndex]
        };
    }

    recompute(clear = true) {
        computeTreeTimings({
            tree: this.tree,
            sourceSamplesCount: this.samplesTimings.samplesCount,
            sourceSamplesTimes: this.samplesTimings.samplesTimes,
            sampleIdToNode: this.tree.sampleIdToNode,
            parent: this.tree.parent,
            samplesCount: this.samplesCount,
            selfTimes: this.selfTimes,
            nestedTimes: this.nestedTimes
        }, clear);
    }
}

export type DictionaryTiming<T> = {
    entryIndex: number;
    entry: T;
    samples: number;
    selfTime: number;
    nestedTime: number;
    totalTime: number;
};

export class DictionaryTimings<T extends CpuProNode> extends TimingsObserver {
    entries: DictionaryTiming<T>[];
    entriesMap: Map<T, DictionaryTiming<T>>;
    samplesCount: Uint32Array;
    selfTimes: Uint32Array;
    totalTimes: Uint32Array;

    constructor(
        dictionary: T[],
        samplesCount: Uint32Array,
        selfTimes: Uint32Array,
        totalTimes: Uint32Array
    ) {
        super();

        this.samplesCount = samplesCount;
        this.selfTimes = selfTimes;
        this.totalTimes = totalTimes;
        this.entries = dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            samples: samplesCount[entryIndex],
            selfTime: selfTimes[entryIndex],
            nestedTime: totalTimes[entryIndex] - selfTimes[entryIndex],
            totalTime: totalTimes[entryIndex]
        }));
        this.entriesMap = this.entries.reduce(
            (map, element) => map.set(element.entry, element),
            new Map()
        );
    }

    getEntry(sourceEntry: T): DictionaryTiming<T> | null {
        return this.entriesMap.get(sourceEntry) || null;
    }

    sync() {
        const { entries, samplesCount, selfTimes, totalTimes } = this;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const selfTime = selfTimes[i];
            const totalTime = totalTimes[i];

            entry.samples = samplesCount[i];
            entry.selfTime = selfTime;
            entry.nestedTime = totalTime - selfTime;
            entry.totalTime = totalTime;
        }
    }
}

export type DictionarySeen<T> = {
    entryIndex: number;
    entry: T;
    firstSeen: number;
    lastSeen: number;
};

export class TreeTimestamps<T extends CpuProNode> {
    entries: DictionarySeen<T>[];
    entriesMap: Map<T, DictionaryTiming<T>>;
    firstSeen: Uint32Array;
    lastSeen: Uint32Array;

    constructor(tree: CallTree<T>, timestamps: Uint32Array, samples: Uint32Array) {
        const { dictionary, nodes, parent, sampleIdToNode } = tree;
        const firstSeen = new Uint32Array(nodes.length).fill(0xffffffff);
        const lastSeen = new Uint32Array(nodes.length);
        const firstSeenDict = new Uint32Array(dictionary.length).fill(0xffffffff);
        const lastSeenDict = new Uint32Array(dictionary.length);

        for (let i = 0; i < samples.length; i++) {
            const nodeId = sampleIdToNode[samples[i]];
            const timestamp = timestamps[i];

            if (firstSeen[nodeId] > timestamp) {
                firstSeen[nodeId] = timestamp;
            }

            if (lastSeen[nodeId] < timestamp) {
                lastSeen[nodeId] = timestamp;
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

export function createTreeComputeBuffer<T>(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    trees: CallTree<T>[],
    useWasm = true
) {
    const maps = trees.map(createMapsFromTree);

    // estimate buffer size
    const samplesMapSize = trees[0].sampleIdToNode.length;
    let bufferSize =
        // timeDeltas
        // timestamps
        2 * timeDeltas.length +
        // samples
        samples.length +
        // samplesMask
        // samplesCount
        // samplesTime
        3 * samplesMapSize;

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        // tree timings
        bufferSize +=
            // sampleIdToNode
            tree.sampleIdToNode.length +
            // parent
            tree.parent.length +
            // samplesCount
            // selfTime
            // nestTime
            3 * tree.nodes.length;

        // dict timings
        bufferSize +=
            sampleIdToDict.length +
            totalNodes.length +
            totalNodeToDict.length +
            // samplesCount
            // selfTime
            // totalTime
            3 * tree.dictionary.length;
    }

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize); // TODO: remove the allocation
    const buffer = memory ? new Uint32Array(memory.buffer) : null;
    let bufferOffset = 0;
    const samplesMap: BufferSamplesTimingsMap = {
        timeDeltas: adopt(timeDeltas),
        timestamps: alloc(timeDeltas.length),
        samples: adopt(samples),
        samplesMask: alloc(samplesMapSize),
        samplesCount: alloc(samplesMapSize),
        samplesTimes: alloc(samplesMapSize)
    };
    const bufferMap: BufferMap<T> = {
        memory,
        samples: samplesMap,
        tree: [],
        dict: []
    };

    computeTimestamps(samplesMap.timestamps, samplesMap.timeDeltas);

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        const treeMap: BufferTreeTimingsMap<T> = {
            tree,
            sourceSamplesCount: samplesMap.samplesCount,
            sourceSamplesTimes: samplesMap.samplesTimes,
            sampleIdToNode: tree.sampleIdToNode = adopt(tree.sampleIdToNode),
            parent: adopt(tree.parent),
            samplesCount: alloc(tree.nodes.length),
            selfTimes: alloc(tree.nodes.length),
            nestedTimes: alloc(tree.nodes.length)
        };
        const dictMap: BufferDictionaryTimingsMap<T> = {
            dictionary: tree.dictionary,
            sourceSamplesCount: samplesMap.samplesCount,
            sourceSamplesTimes: samplesMap.samplesTimes,
            nodeSelfTimes: treeMap.selfTimes,
            nodeNestedTimes: treeMap.nestedTimes,
            sampleIdToDict: adopt(sampleIdToDict),
            totalNodes: adopt(totalNodes),
            totalNodeToDict: adopt(totalNodeToDict),
            samplesCount: alloc(tree.dictionary.length),
            selfTimes: alloc(tree.dictionary.length),
            totalTimes: alloc(tree.dictionary.length)
        };

        bufferMap.tree.push(treeMap);
        bufferMap.dict.push(dictMap);
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

export function createTreeCompute(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    trees: CallTree<CpuProNode>[]
) {
    const useWasm = USE_WASM;
    const bufferMap = createTreeComputeBuffer(samples, timeDeltas, trees, useWasm);
    const {
        memory,
        samples: samplesMap,
        tree: treeMaps,
        dict: dictMaps
    } = bufferMap;
    const computeTimingsApi = useWasm && memory
        ? createWasmApi(memory)
        : computeTimingsJavaScriptApi;

    computeAll(computeTimingsApi, bufferMap, false);

    const samplesTimings = new SamplesTimings(
        samples,
        timeDeltas,
        samplesMap.timestamps,
        samplesMap.samplesCount.slice(),
        samplesMap.samplesTimes.slice()
    );
    const samplesTimingsFiltered = new SamplesTimingsFiltered(
        samplesMap.samples,
        samplesMap.samplesMask,
        samplesMap.timeDeltas,
        samplesMap.timestamps,
        samplesMap.samplesCount,
        samplesMap.samplesTimes
    );
    const treeTimings = treeMaps.map((treeMap) =>
        new TreeTimings(
            treeMap.tree,
            treeMap.samplesCount.slice(),
            treeMap.selfTimes.slice(),
            treeMap.nestedTimes.slice()
        ));
    const treeTimingsFiltered = treeMaps.map((treeMap) =>
        new TreeTimings(
            treeMap.tree,
            treeMap.samplesCount,
            treeMap.selfTimes,
            treeMap.nestedTimes
        ));
    const dictionaryTimings = dictMaps.map((dictMap) =>
        new DictionaryTimings(
            dictMap.dictionary,
            dictMap.samplesCount.slice(),
            dictMap.selfTimes.slice(),
            dictMap.totalTimes.slice()
        ));
    const dictionaryTimingsFiltered = dictMaps.map((dictMap) =>
        new DictionaryTimings(
            dictMap.dictionary,
            dictMap.samplesCount,
            dictMap.selfTimes,
            dictMap.totalTimes
        ));

    // const t = Date.now();
    const treeTimestamps = treeMaps.map((treeMap) =>
        new TreeTimestamps(
            treeMap.tree,
            samplesMap.timestamps,
            samplesMap.samples
        )
    );
    // console.log(Date.now() - t, treeTimestamps);

    // temporary solution
    const { setRange, resetRange } = samplesTimingsFiltered;
    const notifySubjects = [samplesTimingsFiltered, ...treeTimingsFiltered, ...dictionaryTimingsFiltered];
    const recomputeTimings = () => {
        for (let i = 0; i < dictMaps.length; i++) {
            const { sampleIdToNode: sampleIdToNode, tree: { nodes, sampleIdToNodeChanged } } = treeMaps[i];
            const { sampleIdToDict: sampleIdToDict } = dictMaps[i];

            if (sampleIdToNodeChanged) {
                for (let j = 0; j < sampleIdToNode.length; j++) {
                    sampleIdToDict[j] = nodes[sampleIdToNode[j]];
                }

                // FIXME: temporary solution to avoid unnecessary dict recalculations
                treeMaps[i].tree.sampleIdToNodeChanged = false;
            }
        }

        computeAll(computeTimingsApi, bufferMap);
        dictionaryTimingsFiltered.forEach(timings => timings.sync());
        notifySubjects.forEach(timings => timings.notify());
    };
    samplesTimingsFiltered.setRange = function(...args) {
        setRange.call(this, ...args);
        recomputeTimings();
    };
    samplesTimingsFiltered.resetRange = function(...args) {
        resetRange.call(this, ...args);
        recomputeTimings();
    };

    return {
        recomputeTimings,
        samplesTimings,
        samplesTimingsFiltered,
        treeTimings,
        treeTimestamps,
        treeTimingsFiltered,
        dictionaryTimings,
        dictionaryTimingsFiltered
    };
}
