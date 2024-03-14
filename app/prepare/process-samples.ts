import { TIMINGS } from './const';
import { CallTree } from './call-tree';
import {
    CpuProNode,
    CpuProCallFrame,
    CpuProFunction,
    CpuProModule,
    CpuProArea,
    CpuProPackage,
    V8CpuProfileNode
} from './types';

class SamplesTiminigs {
    epoch: number;
    samples: Uint32Array;
    timeDeltas: Uint32Array;
    selfTimes: Uint32Array;

    constructor(size: number, samples: Uint32Array, timeDeltas: Uint32Array) {
        this.epoch = 0;
        this.samples = samples;
        this.timeDeltas = timeDeltas;
        this.selfTimes = new Uint32Array(size);
        this.compute();
    }

    compute() {
        const { samples, timeDeltas, selfTimes } = this;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
        }

        for (let i = 0; i < samples.length; i++) {
            selfTimes[samples[i]] += timeDeltas[i];
        }
    }
}

class TreeTiminigs<T extends CpuProNode> {
    epoch: number;
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    sourceTimings: SamplesTiminigs;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(tree: CallTree<T>, sampleToNode: Uint32Array, sourceTimings: SamplesTiminigs) {
        this.epoch = 0;
        this.tree = tree;
        this.sampleToNode = sampleToNode;
        this.sourceTimings = sourceTimings;
        this.selfTimes = new Uint32Array(tree.nodes.length);
        this.nestedTimes = new Uint32Array(tree.nodes.length);
        this.compute();
    }

    compute() {
        const { selfTimes: sourceSelfTimings } = this.sourceTimings;
        const { parent } = this.tree;
        const { sampleToNode, selfTimes, nestedTimes } = this;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
            nestedTimes.fill(0);
        }

        for (let i = 0; i < sourceSelfTimings.length; i++) {
            selfTimes[sampleToNode[i]] += sourceSelfTimings[i];
        }

        for (let i = selfTimes.length - 1; i > 0; i--) {
            nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
        }
    }
}

type DictionaryTiminig<T> = {
    entry: T;
    selfTime: number;
    nestedTime: number;
    totalTime: number;
};
class DictionaryTiminigs<T extends CpuProNode> {
    epoch: number;
    sourceTimings: TreeTiminigs<T>;
    selfTimes: Uint32Array;
    totalTimes: Uint32Array;
    entries: DictionaryTiminig<T>[];

    constructor(sourceTimings: TreeTiminigs<T>) {
        this.epoch = 0;
        this.sourceTimings = sourceTimings;
        this.selfTimes = new Uint32Array(sourceTimings.tree.dictionary.length);
        this.totalTimes = new Uint32Array(sourceTimings.tree.dictionary.length);
        this.entries = sourceTimings.tree.dictionary.map(entry => ({
            entry,
            selfTime: 0,
            nestedTime: 0,
            totalTime: 0
        }));

        this.compute();
    }

    compute() {
        const { selfTimes, totalTimes: nestedTimes } = this;
        const {
            selfTimes: sourceSelfTimings,
            nestedTimes: sourceNestedTimings,
            tree: { nodes, nested }
        } = this.sourceTimings;

        if (this.epoch++ > 0) {
            selfTimes.fill(0);
            nestedTimes.fill(0);
        }

        for (let i = nodes.length - 1; i >= 0; i--) {
            const index = nodes[i];
            const selfTime = sourceSelfTimings[i];

            selfTimes[index] += selfTime;

            if (nested[i] === 0) {
                nestedTimes[index] += selfTime + sourceNestedTimings[i];
            }
        }
    }

    applyTimesToDictionary() {
        const { entries, selfTimes, totalTimes } = this;
        const { tree: { dictionary } } = this.sourceTimings;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];

            entry.selfTime = selfTimes[i];
            entry.nestedTime = totalTimes[i] - selfTimes[i];
            entry.totalTime = totalTimes[i];
        }

        for (let i = 0; i < dictionary.length; i++) {
            dictionary[i].selfTime = selfTimes[i];
            dictionary[i].totalTime = totalTimes[i];
        }
    }
}

function computeTimings<T extends CpuProNode>(
    name: string,
    tree: CallTree<T>,
    sampleToNode: Uint32Array,
    samplesTimings: SamplesTiminigs
) {
    const treeTimings = new TreeTiminigs(tree, sampleToNode, samplesTimings);
    const dictionaryTimings = new DictionaryTiminigs(treeTimings);

    tree.selfTimes = treeTimings.selfTimes;
    tree.nestedTimes = treeTimings.nestedTimes;
    dictionaryTimings.applyTimesToDictionary();

    return { treeTimings, dictionaryTimings };
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
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    callFramesTree: CallTree<CpuProCallFrame>,
    functionsTree: CallTree<CpuProFunction>,
    modulesTree: CallTree<CpuProModule>,
    packagesTree: CallTree<CpuProPackage>,
    areasTree: CallTree<CpuProArea>
) {
    const remapSamplesStart = Date.now();
    let sampleToNode = remapSamples(samples, callFramesTree.mapToIndex);
    callFramesTree.mapToIndex = sampleToNode;
    TIMINGS && console.log('re-map samples', Date.now() - remapSamplesStart);

    // let prev = samples[0];
    // let k = 0;
    // samples[0] = nodeById[prev];
    // for (let i = 1, k = 1; i < samples.length; i++) {
    //     const sample = samples[i];
    //     if (sample !== prev) {
    //         timeDeltas[k] = timeDeltas[i];
    //         samples[k++] = nodeById[sample];
    //         prev = sample;
    //     } else {
    //         timeDeltas[k - 1] += timeDeltas[i];
    //     }
    // }

    const t = Date.now();
    const samplesTimings = new SamplesTiminigs(sampleToNode.length, samples, timeDeltas);
    console.log('SamplesTiminigs', Date.now() - t);

    const computeTimingsStart = Date.now();
    const result = Object.create(null);
    TIMINGS && console.group('Compute timings');

    for (const { name, tree } of [
        { name: 'functions', tree: functionsTree },
        { name: 'modules', tree: modulesTree },
        { name: 'packages', tree: packagesTree },
        { name: 'areas', tree: areasTree }
    ] as const) {
        const startTime = Date.now();

        sampleToNode = sampleToNode.map(id => tree.mapToIndex[id]);
        tree.mapToIndex = sampleToNode;

        const { treeTimings, dictionaryTimings } = computeTimings(name, tree, sampleToNode, samplesTimings);
        result[`${name}TreeTimings`] = treeTimings;
        result[`${name}Timings`] = dictionaryTimings;

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
