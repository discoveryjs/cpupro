import { TIMINGS } from './const.js';
import { CallTree } from './call-tree.js';
import { DictionaryTiminigs, SamplesTiminigs, TreeTiminigs } from './compute-timings.js';
import {
    CpuProNode,
    CpuProCallFrame,
    CpuProFunction,
    CpuProModule,
    CpuProArea,
    CpuProPackage,
    V8CpuProfileNode
} from './types.js';

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
