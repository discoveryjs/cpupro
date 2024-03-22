import { TIMINGS } from './const.js';
import { CallTree } from './call-tree.js';
import {
    CpuProNode,
    CpuProCallFrame,
    CpuProFunction,
    CpuProModule,
    CpuProArea,
    CpuProPackage,
    V8CpuProfileNode
} from './types.js';

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
    epoch: number;
    samples: Uint32Array;
    timeDeltas: Uint32Array;
    originalTimeDeltas: Uint32Array;
    timestamps: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
    selfTimes: Uint32Array;

    constructor(
        size: number,
        samples: Uint32Array,
        timeDeltas: Uint32Array,
        selfTimes?: Uint32Array
    ) {
        super();

        this.epoch = 0;
        this.samples = samples;
        this.timeDeltas = timeDeltas;
        this.originalTimeDeltas = timeDeltas;
        this.timestamps = null;
        this.selfTimes = selfTimes || new Uint32Array(size);

        if (!selfTimes) {
            this.compute();
        }
    }

    clone() {
        return new SamplesTiminigs(
            this.selfTimes.length,
            this.samples,
            this.originalTimeDeltas,
            // skip compute when no filters applied
            this.timeDeltas === this.originalTimeDeltas
                ? this.selfTimes.slice()
                : undefined
        );
    }

    compute() {
        const { samples, timeDeltas, selfTimes } = this;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
        }

        for (let i = 0; i < samples.length; i++) {
            selfTimes[samples[i]] += timeDeltas[i];
        }

        this.notify();
    }

    resetRange() {
        this.rangeStart = null;
        this.rangeEnd = null;

        if (this.timeDeltas !== this.originalTimeDeltas) {
            this.timeDeltas = this.originalTimeDeltas;
        }
    }
    setRange(start: number, end: number) {
        const { originalTimeDeltas } = this;
        let { timeDeltas, timestamps } = this;

        this.rangeStart = start;
        this.rangeEnd = end;

        if (timeDeltas === this.originalTimeDeltas) {
            this.timeDeltas = timeDeltas = new Uint32Array(timeDeltas.length);
        } else {
            timeDeltas.fill(0);
        }

        if (timestamps === null) {
            this.timestamps = timestamps = new Uint32Array(timeDeltas.length);

            for (let i = 1; i < timestamps.length; i++) {
                timestamps[i] = originalTimeDeltas[i - 1] + timestamps[i - 1];
            }
        }

        const startIndex = binarySearch(timestamps, start);
        const endIndex = binarySearch(timestamps, end);

        if (startIndex !== endIndex) {
            timeDeltas[startIndex] = originalTimeDeltas[startIndex] - (start - timestamps[startIndex]);
            timeDeltas[endIndex] = end - timestamps[endIndex];

            if (startIndex + 1 < endIndex) {
                timeDeltas.set(this.originalTimeDeltas.subarray(startIndex + 1, endIndex), startIndex + 1);
            }
        } else {
            timeDeltas[startIndex] = end - start;
        }

        // let sum = timeDeltas.reduce((s, i) => s + i, 0);
        // console.log('setRange', Date.now() - t, {start, end}, startIndex, endIndex, { range: end - start, sum });
    }
}

export class TreeTiminigs<T extends CpuProNode> extends TimingsObserver {
    epoch: number;
    tree: CallTree<T>;
    sampleIdToNode: Uint32Array;
    sourceTimings: SamplesTiminigs;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(tree: CallTree<T>, sampleIdToNode: Uint32Array, sourceTimings: SamplesTiminigs) {
        const { nodes } = tree;

        super();

        this.epoch = 0;
        this.tree = tree;
        this.sampleIdToNode = sampleIdToNode;
        this.sourceTimings = sourceTimings;
        this.selfTimes = new Uint32Array(nodes.length);
        this.nestedTimes = new Uint32Array(nodes.length);

        this.compute();
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

    compute() {
        const { selfTimes: sourceSelfTimings } = this.sourceTimings;
        const { parent } = this.tree;
        const { sampleIdToNode, selfTimes, nestedTimes } = this;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
            nestedTimes.fill(0);
        }

        for (let i = 0; i < sourceSelfTimings.length; i++) {
            selfTimes[sampleIdToNode[i]] += sourceSelfTimings[i];
        }

        for (let i = selfTimes.length - 1; i > 0; i--) {
            nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
        }

        this.notify();
    }
}

export type DictionaryTiminig<T> = {
    entry: T;
    selfTime: number;
    nestedTime: number;
    totalTime: number;
};
export class DictionaryTiminigs<T extends CpuProNode> extends TimingsObserver {
    epoch: number;
    sourceTreeTimings: TreeTiminigs<T>;
    selfTimes: Uint32Array;
    totalTimes: Uint32Array;
    entries: DictionaryTiminig<T>[];
    entriesMap: Map<T, DictionaryTiminig<T>>;

    constructor(sourceTreeTimings: TreeTiminigs<T>) {
        const { dictionary } = sourceTreeTimings.tree;
        const entries = dictionary.map((entry, entryIndex) => ({
            entryIndex,
            entry,
            selfTime: 0,
            nestedTime: 0,
            totalTime: 0
        }));

        super();

        this.epoch = 0;
        this.sourceTreeTimings = sourceTreeTimings;
        this.selfTimes = new Uint32Array(dictionary.length);
        this.totalTimes = new Uint32Array(dictionary.length);
        this.entries = entries;
        this.entriesMap = entries.reduce(
            (map, element) => map.set(element.entry, element),
            new Map()
        );

        this.compute();
    }

    getEntry(sourceEntry: T): DictionaryTiminig<T> | null {
        return this.entriesMap.get(sourceEntry) || null;
    }

    compute() {
        const { selfTimes, totalTimes, entries } = this;
        const {
            tree: { nodes, nested },
            selfTimes: sourceSelfTimings,
            nestedTimes: sourceNestedTimings
        } = this.sourceTreeTimings;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
            totalTimes.fill(0);
        }

        for (let i = nodes.length - 1; i >= 0; i--) {
            const index = nodes[i];
            const selfTime = sourceSelfTimings[i];

            selfTimes[index] += selfTime;

            if (nested[i] === 0) {
                totalTimes[index] += selfTime + sourceNestedTimings[i];
            }
        }

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const selfTime = selfTimes[i];
            const totalTime = totalTimes[i];

            entry.selfTime = selfTime;
            entry.nestedTime = totalTime - selfTime;
            entry.totalTime = totalTime;
        }

        this.notify();
    }
}

function createTimings<T extends CpuProNode>(
    tree: CallTree<T>,
    sampleIdToNode: Uint32Array,
    samplesTimings: SamplesTiminigs
) {
    const treeTimings = new TreeTiminigs(tree, sampleIdToNode, samplesTimings);
    const dictionaryTimings = new DictionaryTiminigs(treeTimings);

    return {
        tree: treeTimings,
        dictionary: dictionaryTimings
    };
}

// Merging sequentially identical samples and coresponsing timeDeltas.
// Usually it allows to reduce number of samples for further processing at least by x2
function mergeSamples(samples: Uint32Array, timeDeltas: Uint32Array) {
    let k = 1;

    for (let i = 1; i < samples.length; i++) {
        if (samples[i] !== samples[i - 1]) {
            timeDeltas[k] = timeDeltas[i];
            samples[k] = samples[i];
            k++;
        } else {
            timeDeltas[k - 1] += timeDeltas[i];
        }
    }

    return {
        samples: k !== samples.length ? samples.slice(0, k) : samples,
        timeDeltas: k !== timeDeltas.length ? timeDeltas.slice(0, k) : timeDeltas
    };
}

function remapSamples(samples: Uint32Array, nodeById: Uint32Array) {
    const tmpMap = new Uint32Array(nodeById.length);
    const samplesMap = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];

        if (tmpMap[id] === 0) {
            tmpMap[id] = ++sampledNodesCount;
            samplesMap.push(nodeById[id]);
            samples[i] = sampledNodesCount - 1;
        } else {
            samples[i] = tmpMap[samples[i]] - 1;
        }
    }

    // convert to typed array for faster processing
    return new Uint32Array(samplesMap);
}

export function processSamples(
    rawSamples: Uint32Array,
    rawTimeDeltas: Uint32Array,
    callFramesTree: CallTree<CpuProCallFrame>,
    functionsTree: CallTree<CpuProFunction>,
    modulesTree: CallTree<CpuProModule>,
    packagesTree: CallTree<CpuProPackage>,
    areasTree: CallTree<CpuProArea>
) {
    const mergeSamplesStart = Date.now();
    const { samples, timeDeltas } = mergeSamples(rawSamples, rawTimeDeltas);
    TIMINGS && console.log('merge samples', Date.now() - mergeSamplesStart);

    const remapSamplesStart = Date.now();
    let sampleIdToNode = remapSamples(samples, callFramesTree.sourceIdToNode);
    callFramesTree.sampleIdToNode = sampleIdToNode;
    TIMINGS && console.log('re-map samples', Date.now() - remapSamplesStart);

    const t = Date.now();
    const samplesTimings = new SamplesTiminigs(sampleIdToNode.length, samples, timeDeltas);
    const samplesTimingsFiltered = samplesTimings.clone();
    console.log('SamplesTiminigs', Date.now() - t);

    const computeTimingsStart = Date.now();
    const result = { samplesTimings, samplesTimingsFiltered };
    TIMINGS && console.group('Compute timings');

    for (const { name, tree } of [
        { name: 'functions', tree: functionsTree },
        { name: 'modules', tree: modulesTree },
        { name: 'packages', tree: packagesTree },
        { name: 'areas', tree: areasTree }
    ] as const) {
        const startTime = Date.now();

        sampleIdToNode = sampleIdToNode.map(id => tree.sourceIdToNode[id]);
        tree.sampleIdToNode = sampleIdToNode;

        const timings = createTimings(tree, sampleIdToNode, samplesTimings);
        const timingsFiltered = createTimings(tree, sampleIdToNode, samplesTimingsFiltered);

        result[`${name}Timings`] = timings.dictionary;
        result[`${name}TreeTimings`] = timings.tree;
        result[`${name}TimingsFiltered`] = timingsFiltered.dictionary;
        result[`${name}TreeTimingsFiltered`] = timingsFiltered.tree;

        if (TIMINGS) {
            console.log(`${name}:`, Date.now() - startTime);
        }
    }

    TIMINGS && console.log('Total time:', Date.now() - computeTimingsStart);
    TIMINGS && console.groupEnd();

    return result;
}


export function gcReparenting(samples: number[], nodes: V8CpuProfileNode[], maxNodeId: number) {
    const gcNode = nodes.find(node =>
        node.callFrame.functionName === '(garbage collector)'
    );

    if (gcNode === undefined) {
        return maxNodeId;
    }

    const gcNodeIdByPrevNodeId = new Map<number, number>();
    const gcNodeId = gcNode.id;
    const nodeIdToIndex = new Uint32Array(maxNodeId + 1);

    for (let i = 0; i < nodes.length; i++) {
        nodeIdToIndex[nodes[i].id] = i;
    }

    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else {
                let sampleGcNodeId = gcNodeIdByPrevNodeId.get(prevNodeId);

                if (sampleGcNodeId === undefined) {
                    // create new GC node
                    sampleGcNodeId = ++maxNodeId;

                    const parentNode = nodes[nodeIdToIndex[prevNodeId]];

                    if (Array.isArray(parentNode.children)) {
                        parentNode.children.push(sampleGcNodeId);
                    } else {
                        parentNode.children = [sampleGcNodeId];
                    }

                    gcNodeIdByPrevNodeId.set(prevNodeId, sampleGcNodeId);
                    nodes.push({
                        id: sampleGcNodeId,
                        callFrame: gcNode.callFrame
                    });
                }

                samples[i] = sampleGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }

    return maxNodeId;
}
