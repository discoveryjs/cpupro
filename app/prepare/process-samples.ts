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
    samples: Uint32Array;
    timeDeltas: Uint32Array;
    selfTimes: Uint32Array;

    constructor(size: number, samples: Uint32Array, timeDeltas: Uint32Array) {
        this.samples = samples;
        this.timeDeltas = timeDeltas;
        this.selfTimes = new Uint32Array(size);
        this.compute();
    }

    compute() {
        const { samples, timeDeltas, selfTimes } = this;

        for (let i = 0; i < samples.length; i++) {
            selfTimes[samples[i]] += timeDeltas[i];
        }
    }
}

class TreeTiminigs<T extends CpuProNode> {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    sourceTimings: SamplesTiminigs;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(tree: CallTree<T>, sampleToNode: Uint32Array, sourceTimings: SamplesTiminigs) {
        this.tree = tree;
        this.sourceTimings = sourceTimings;
        this.sampleToNode = sampleToNode;
        this.selfTimes = new Uint32Array(tree.nodes.length);
        this.nestedTimes = new Uint32Array(tree.nodes.length);
        this.compute(false);
    }

    compute(reset = true) {
        const { selfTimes: sourceSelfTimings } = this.sourceTimings;
        const { parent } = this.tree;
        const { sampleToNode, selfTimes, nestedTimes } = this;

        if (reset) {
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

class DictionaryTiminigs<T extends CpuProNode> {
    sourceTimings: TreeTiminigs<T>;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;

    constructor(sourceTimings: TreeTiminigs<T>) {
        this.sourceTimings = sourceTimings;
        this.selfTimes = new Uint32Array(sourceTimings.tree.dictionary.length);
        this.nestedTimes = new Uint32Array(sourceTimings.tree.dictionary.length);
        this.compute(false);
    }

    compute(reset = true) {
        const { selfTimes, nestedTimes } = this;
        const {
            selfTimes: sourceSelfTimings,
            nestedTimes: sourceNestedTimings,
            tree: { nodes, nested }
        } = this.sourceTimings;

        if (reset) {
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
        const { selfTimes, nestedTimes } = this;
        const { tree: { dictionary } } = this.sourceTimings;

        for (let i = 0; i < dictionary.length; i++) {
            dictionary[i].selfTime = selfTimes[i];
            dictionary[i].totalTime = nestedTimes[i];
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

    // populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];

        if (tmpMap[id] === 0) {
            tmpMap[id] = ++sampledNodesCount;
            samplesMap.push(nodeById[id]);
        }
    }

    // remap samples -> samplesMap
    for (let i = 0; i < samples.length; i++) {
        samples[i] = tmpMap[samples[i]] - 1;
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
        computeTimings(name, tree, sampleToNode, samplesTimings);

        if (TIMINGS) {
            console.log(`${name}:`, Date.now() - startTime);
        }
    }

    TIMINGS && console.log('Total time:', Date.now() - computeTimingsStart);
    TIMINGS && console.groupEnd();

    return {

    };
}


export function gcReparenting(samples: number[], nodes: V8CpuProfileNode[], maxNodeId: number) {
    const gcNode = nodes.find(node =>
        node.callFrame.functionName === '(garbage collector)'
    );

    if (gcNode === undefined) {
        return;
    }

    const gcNodeId = gcNode.id;
    const stackToGc = new Map();

    for (let i = 0, prevNodeId = -1; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else {
                if (stackToGc.has(prevNodeId)) {
                    samples[i] = stackToGc.get(prevNodeId);
                } else {
                    const parentNode = nodes[prevNodeId];
                    const newGcNodeId = ++maxNodeId;
                    const newGcNode = {
                        id: newGcNodeId,
                        callFrame: { ...gcNode.callFrame }
                    };

                    stackToGc.set(prevNodeId, newGcNodeId);
                    nodes.push(newGcNode);
                    samples[i] = newGcNodeId;

                    if (Array.isArray(parentNode.children)) {
                        parentNode.children.push(newGcNodeId);
                    } else {
                        parentNode.children = [newGcNodeId];
                    }
                }
            }
        }

        prevNodeId = nodeId;
    }

    return maxNodeId;
}
