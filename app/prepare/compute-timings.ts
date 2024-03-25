import { CallTree } from './call-tree.js';
import { CpuProNode } from './types.js';

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

    return right;
}

function computeTimestamps(timestamps: Uint32Array, timeDeltas: Uint32Array) {
    for (let i = 1; i < timestamps.length; i++) {
        timestamps[i] = timeDeltas[i - 1] + timestamps[i - 1];
    }
}

function computeTimings(
    map: BufferSamplesTimingsMap,
    clear = true
) {
    const {
        samples,
        timeDeltas,
        samplesTimes
    } = extractArrayFromMap(map);
    const samplesCount = samples.length;

    if (clear) {
        samplesTimes.fill(0);
    }

    for (let i = 0; i < samplesCount; i++) {
        samplesTimes[samples[i]] += timeDeltas[i];
    }
}

function computeTreeTimings<T extends CpuProNode>(
    map: BufferTreeTimingsMap<T>,
    clear = true
) {
    const {
        sourceSelfTimes,
        sampleIdToNode,
        parent,
        selfTimes,
        nestedTimes
    } = extractArrayFromMap(map);
    const sourceSelfTimesSize = sourceSelfTimes.length;
    const nodesCount = selfTimes.length;

    if (clear) {
        selfTimes.fill(0);
        nestedTimes.fill(0);
    }

    for (let i = 0; i < sourceSelfTimesSize; i++) {
        selfTimes[sampleIdToNode[i]] += sourceSelfTimes[i];
    }

    for (let i = nodesCount - 1; i > 0; i--) {
        nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
    }
}

function computeDictionaryTimings<T extends CpuProNode>(
    map: BufferDictionaryTimingsMap<T>,
    clear = true
) {
    const {
        samplesSelfTimes,
        nodeSelfTimes,
        nodeNestedTimes,
        sampleIdToDict,
        totalNodes,
        totalNodeToDict,
        selfTimes,
        totalTimes
    } = extractArrayFromMap(map);
    const samplesSelfTimesSize = samplesSelfTimes.length;
    const nodesCount = totalNodes.length;

    if (clear) {
        selfTimes.fill(0);
        totalTimes.fill(0);
    }

    for (let i = 0; i < samplesSelfTimesSize; i++) {
        selfTimes[sampleIdToDict[i]] += samplesSelfTimes[i];
    }

    for (let i = 0; i < nodesCount; i++) {
        const nodeId = totalNodes[i];
        const selfTime = nodeSelfTimes[nodeId];
        const nestedTime = nodeNestedTimes[nodeId];

        totalTimes[totalNodeToDict[i]] += selfTime + nestedTime;
    }
}

function computeAll<T extends CpuProNode>(bufferMap: BufferMap<T>, clear = true) {
    computeTimings(bufferMap.samples);

    for (const treeMap of bufferMap.tree) {
        computeTreeTimings(treeMap, clear);
    }

    for (const dictMap of bufferMap.dict) {
        computeDictionaryTimings(dictMap, clear);
    }
}

export type Listener = { fn: () => void };
export class TimingsObserver {
    listeners: Listener[] = [];
    on(fn: () => void) {
        let listener = { fn };
        this.listeners.push(listener);

        return () => {
            if (listener !== null) {
                this.listeners = this.listeners.filter(el => el !== listener);
                listener = null;
            }
        };
    }

    notify() {
        for (const { fn } of this.listeners) {
            fn();
        }
    }
}

export class SamplesTiminigs extends TimingsObserver {
    samples: Uint32Array;
    samplesMask: Uint32Array;
    timeDeltas: Uint32Array;
    originalTimeDeltas: Uint32Array;
    timestamps: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
    selfTimes: Uint32Array;

    constructor(
        samples: Uint32Array,
        samplesMask: Uint32Array,
        timeDeltas: Uint32Array,
        timestamps: Uint32Array,
        selfTimes: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.samplesMask = samplesMask;
        this.timeDeltas = timeDeltas;
        this.originalTimeDeltas = timeDeltas;
        this.timestamps = timestamps;
        this.selfTimes = selfTimes;
    }

    resetRange() {
        this.rangeStart = null;
        this.rangeEnd = null;

        if (this.timeDeltas !== this.originalTimeDeltas) {
            this.timeDeltas.set(this.originalTimeDeltas);
            this.originalTimeDeltas = this.timeDeltas;
        }
    }
    setRange(start: number, end: number) {
        const { originalTimeDeltas, timeDeltas, timestamps } = this;

        this.rangeStart = start;
        this.rangeEnd = end;

        if (timeDeltas === this.originalTimeDeltas) {
            this.originalTimeDeltas = timeDeltas.slice();
        }

        timeDeltas.fill(0);

        const startIndex = binarySearch(timestamps, start);
        const endIndex = binarySearch(timestamps, end);

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

export class TreeTiminigs<T extends CpuProNode> extends TimingsObserver {
    tree: CallTree<T>;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(tree: CallTree<T>, selfTimes: Uint32Array, nestedTimes: Uint32Array) {
        super();

        this.tree = tree;
        this.selfTimes = selfTimes;
        this.nestedTimes = nestedTimes;
    }

    getTimings(index: number) {
        const selfTime = this.selfTimes[index];
        const nestedTime = this.nestedTimes[index];

        return {
            node: this.tree.getEntry(index),
            selfTime,
            nestedTime,
            totalTime: selfTime + nestedTime
        };
    }
}

export type DictionaryTiminig<T> = {
    entry: T;
    selfTime: number;
    nestedTime: number;
    totalTime: number;
};

export class DictionaryTiminigs<T extends CpuProNode> extends TimingsObserver {
    entries: DictionaryTiminig<T>[];
    entriesMap: Map<T, DictionaryTiminig<T>>;
    selfTimes: Uint32Array;
    totalTimes: Uint32Array;

    constructor(dictionary: T[], selfTimes: Uint32Array, totalTimes: Uint32Array) {
        super();

        this.selfTimes = selfTimes;
        this.totalTimes = totalTimes;
        this.entries = dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            selfTime: selfTimes[entryIndex],
            nestedTime: totalTimes[entryIndex] - selfTimes[entryIndex],
            totalTime: totalTimes[entryIndex]
        }));
        this.entriesMap = this.entries.reduce(
            (map, element) => map.set(element.entry, element),
            new Map()
        );
    }

    getEntry(sourceEntry: T): DictionaryTiminig<T> | null {
        return this.entriesMap.get(sourceEntry) || null;
    }

    sync() {
        const { entries, selfTimes, totalTimes } = this;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const selfTime = selfTimes[i];
            const totalTime = totalTimes[i];

            entry.selfTime = selfTime;
            entry.nestedTime = totalTime - selfTime;
            entry.totalTime = totalTime;
        }
    }
}

type BufferMapRecord = { offset: number, array: Uint32Array };
type BufferMap<T> = {
    samples: BufferSamplesTimingsMap;
    tree: BufferTreeTimingsMap<T>[];
    dict: BufferDictionaryTimingsMap<T>[];
};
type BufferSamplesTimingsMap = {
    buffer: Uint32Array;
    samples: BufferMapRecord;
    samplesMask: BufferMapRecord;
    timeDeltas: BufferMapRecord;
    timestamps: BufferMapRecord;
    samplesTimes: BufferMapRecord;
};
type BufferTreeTimingsMap<T> = {
    buffer: Uint32Array;
    tree: CallTree<T>;
    sourceSelfTimes: BufferMapRecord;
    sampleIdToNode: BufferMapRecord;
    parent: BufferMapRecord;
    selfTimes: BufferMapRecord;
    nestedTimes: BufferMapRecord;
};
type BufferDictionaryTimingsMap<T> = {
    buffer: Uint32Array;
    dictionary: T[];
    samplesSelfTimes: BufferMapRecord;
    nodeSelfTimes: BufferMapRecord;
    nodeNestedTimes: BufferMapRecord;
    sampleIdToDict: BufferMapRecord;
    totalNodes: BufferMapRecord;
    totalNodeToDict: BufferMapRecord;
    selfTimes: BufferMapRecord;
    totalTimes: BufferMapRecord;
};

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

function extractArrayFromMap<
    T extends BufferSamplesTimingsMap | BufferTreeTimingsMap<U> | BufferDictionaryTimingsMap<U>,
    U extends CpuProNode
>(map: T): Record<Exclude<keyof T, 'buffer'>, Uint32Array> {
    const result: Record<keyof T, Uint32Array> = Object.create(null);

    for (const [key, value] of Object.entries(map)) {
        if ('array' in value) {
            result[key] = value.array;
        }
    }

    return result;
}

export function createTreeComputeBuffer<T>(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    trees: CallTree<T>[]
) {
    const maps = trees.map(createMapsFromTree);

    // estimate buffer size
    const samplesMapSize = trees[0].sampleIdToNode.length;
    let bufferSize =
        // samples
        samples.length +
        // timeDeltas
        // timestamps
        2 * timeDeltas.length +
        // samplesMask
        // samplesTime
        2 * samplesMapSize;

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        // tree timings
        bufferSize +=
            // sampleIdToNode
            tree.sampleIdToNode.length +
            // parent
            tree.parent.length +
            // selfTime
            // nestTime
            2 * tree.nodes.length;

        // dict timings
        bufferSize +=
            sampleIdToDict.length +
            totalNodes.length +
            totalNodeToDict.length +
            // selfTime
            // totalTime
            2 * tree.dictionary.length;
    }

    const buffer = new Uint32Array(bufferSize);
    let offset = 0;
    const samplesMap: BufferSamplesTimingsMap = {
        buffer,
        samples: alloc(samples),
        samplesMask: alloc(samplesMapSize),
        timeDeltas: alloc(timeDeltas),
        timestamps: alloc(timeDeltas.length),
        samplesTimes: alloc(samplesMapSize)
    };
    const bufferMap: BufferMap<T> = {
        samples: samplesMap,
        tree: [],
        dict: []
    };

    computeTimestamps(samplesMap.timestamps.array, samplesMap.timeDeltas.array);

    for (const { tree, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
        const treeMap: BufferTreeTimingsMap<T> = {
            buffer,
            tree,
            sourceSelfTimes: samplesMap.samplesTimes,
            sampleIdToNode: alloc(tree.sampleIdToNode),
            parent: alloc(tree.parent),
            selfTimes: alloc(tree.nodes.length),
            nestedTimes: alloc(tree.nodes.length)
        };
        const dictMap: BufferDictionaryTimingsMap<T> = {
            buffer,
            dictionary: tree.dictionary,
            samplesSelfTimes: samplesMap.samplesTimes,
            nodeSelfTimes: treeMap.selfTimes,
            nodeNestedTimes: treeMap.nestedTimes,
            sampleIdToDict: alloc(sampleIdToDict),
            totalNodes: alloc(totalNodes),
            totalNodeToDict: alloc(totalNodeToDict),
            selfTimes: alloc(tree.dictionary.length),
            totalTimes: alloc(tree.dictionary.length)
        };

        bufferMap.tree.push(treeMap);
        bufferMap.dict.push(dictMap);
    }

    return bufferMap;

    function alloc(array: number | Uint32Array) {
        const record = { offset, array: null };

        if (typeof array === 'number') {
            offset += array;
        } else {
            buffer.set(array, offset);
            offset += array.length;
        }

        record.array = buffer.subarray(record.offset, offset);

        return record;
    }
}

export function createTreeCompute<T extends CpuProNode>(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    trees: CallTree<T>[]
) {
    const bufferMap = createTreeComputeBuffer(samples, timeDeltas, trees);
    const {
        samples: samplesMap,
        tree: treeMaps,
        dict: dictMaps
    } = bufferMap;

    computeAll(bufferMap, false);

    const samplesTimings = new SamplesTiminigs(
        samplesMap.samples.array,
        samplesMap.samplesMask.array,
        samplesMap.timeDeltas.array,
        samplesMap.timestamps.array,
        samplesMap.samplesTimes.array
    );
    const treeTimings = treeMaps.map((treeMap) =>
        new TreeTiminigs(
            treeMap.tree,
            treeMap.selfTimes.array,
            treeMap.nestedTimes.array
        ));
    const dictTimings = dictMaps.map((dictMap) =>
        new DictionaryTiminigs(
            dictMap.dictionary,
            dictMap.selfTimes.array,
            dictMap.totalTimes.array
        ));

    // temporary solution
    const { setRange, resetRange } = samplesTimings;
    const notifySubjects = [samplesTimings, ...treeTimings, ...dictTimings];
    samplesTimings.setRange = function(...args) {
        setRange.call(this, ...args);
        computeAll(bufferMap);
        dictTimings.forEach(timings => timings.sync());
        notifySubjects.forEach(timings => timings.notify());
    };
    samplesTimings.resetRange = function(...args) {
        resetRange.call(this, ...args);
        computeAll(bufferMap);
        dictTimings.forEach(timings => timings.sync());
        notifySubjects.forEach(timings => timings.notify());
    };

    return {
        samples: samplesTimings,
        trees: treeTimings,
        dictionaries: dictTimings
    };
}
