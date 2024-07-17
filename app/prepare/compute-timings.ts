import { USE_WASM } from './const.js';
import { CpuProNode } from './types.js';
import { CallTree } from './call-tree.js';
import {
    BufferDictionaryTimingsMap,
    BufferMap,
    BufferSamplesTimingsMap,
    BufferTreeTimingsMap,
    ComputeTimingsApi,
    createJavaScriptApi,
    createWasmApi
} from './compute-timings-wasm-wrapper.js';

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
    #listeners: Listener[] = [];
    on(fn: () => void) {
        let listener: Listener | null = { fn };
        this.#listeners.push(listener);

        return () => {
            if (listener !== null) {
                this.#listeners = this.#listeners.filter(el => el !== listener);
                listener = null;
            }
        };
    }

    notify() {
        for (const { fn } of this.#listeners) {
            fn();
        }
    }
}

export class SamplesTiminigs extends TimingsObserver {
    samples: Uint32Array;
    timeDeltas: Uint32Array;
    timestamps: Uint32Array;
    selfTimes: Uint32Array;

    constructor(
        samples: Uint32Array,
        timeDeltas: Uint32Array,
        timestamps: Uint32Array,
        selfTimes: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.timeDeltas = timeDeltas;
        this.timestamps = timestamps;
        this.selfTimes = selfTimes;
    }
}

export class SamplesTiminigsFiltered extends SamplesTiminigs {
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
        selfTimes: Uint32Array
    ) {
        super(
            samples,
            timeDeltas,
            timestamps,
            selfTimes
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

    getValueTimings(valueIndex: number) {
        const { tree, selfTimes, nestedTimes } = this;
        const { nested } = tree;
        let selfTime = 0;
        let nestedTime = 0;

        for (const index of tree.selectNodes(valueIndex, true)) {
            selfTime += selfTimes[index];
            if (nested[index] === 0) {
                nestedTime += nestedTimes[index];
            }
        }

        return {
            value: tree.dictionary[valueIndex],
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

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint32Array(4 * bufferSize);
    const buffer = new Uint32Array(memory.buffer);
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
        memory,
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
        const arrayOffset = offset;
        const record = { offset, array: null };

        if (typeof array === 'number') {
            offset += array << 2;
        } else {
            buffer.set(array, offset >> 2);
            offset += array.length << 2;
        }

        return {
            offset: arrayOffset,
            array: buffer.subarray(record.offset >> 2, offset >> 2)
        };
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
    const computeTimingsApi = useWasm
        ? createWasmApi(memory as WebAssembly.Memory)
        : createJavaScriptApi();

    computeAll(computeTimingsApi, bufferMap, false);

    const samplesTimings = new SamplesTiminigs(
        samples,
        timeDeltas,
        samplesMap.timestamps.array,
        samplesMap.samplesTimes.array.slice()
    );
    const samplesTimingsFiltered = new SamplesTiminigsFiltered(
        samplesMap.samples.array,
        samplesMap.samplesMask.array,
        samplesMap.timeDeltas.array,
        samplesMap.timestamps.array,
        samplesMap.samplesTimes.array
    );
    const treeTimings = treeMaps.map((treeMap) =>
        new TreeTiminigs(
            treeMap.tree,
            treeMap.selfTimes.array.slice(),
            treeMap.nestedTimes.array.slice()
        ));
    const treeTimingsFiltered = treeMaps.map((treeMap) =>
        new TreeTiminigs(
            treeMap.tree,
            treeMap.selfTimes.array,
            treeMap.nestedTimes.array
        ));
    const dictionaryTimings = dictMaps.map((dictMap) =>
        new DictionaryTiminigs(
            dictMap.dictionary,
            dictMap.selfTimes.array.slice(),
            dictMap.totalTimes.array.slice()
        ));
    const dictionaryTimingsFiltered = dictMaps.map((dictMap) =>
        new DictionaryTiminigs(
            dictMap.dictionary,
            dictMap.selfTimes.array,
            dictMap.totalTimes.array
        ));

    // temporary solution
    const { setRange, resetRange } = samplesTimingsFiltered;
    const notifySubjects = [samplesTimingsFiltered, ...treeTimingsFiltered, ...dictionaryTimingsFiltered];
    samplesTimingsFiltered.setRange = function(...args) {
        setRange.call(this, ...args);
        computeAll(computeTimingsApi, bufferMap);
        dictionaryTimingsFiltered.forEach(timings => timings.sync());
        notifySubjects.forEach(timings => timings.notify());
    };
    samplesTimingsFiltered.resetRange = function(...args) {
        resetRange.call(this, ...args);
        computeAll(computeTimingsApi, bufferMap);
        dictionaryTimingsFiltered.forEach(timings => timings.sync());
        notifySubjects.forEach(timings => timings.notify());
    };

    return {
        samplesTimings,
        samplesTimingsFiltered,
        treeTimings,
        treeTimingsFiltered,
        dictionaryTimings,
        dictionaryTimingsFiltered
    };
}
