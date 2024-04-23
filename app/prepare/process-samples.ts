import { TIMINGS } from './const.js';
import { CallTree } from './call-tree.js';
import { createTreeCompute } from './compute-timings.js';
import {
    CpuProCallFrame,
    CpuProFunction,
    CpuProModule,
    CpuProCategory,
    CpuProPackage,
    V8CpuProfileNode
} from './types.js';

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
    const samplesMap: number[] = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];
        const newSampleId = tmpMap[id];

        if (newSampleId === 0) {
            samplesMap.push(nodeById[id]);
            tmpMap[id] = ++sampledNodesCount;
            samples[i] = sampledNodesCount - 1;
        } else {
            samples[i] = newSampleId - 1;
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
    categoriesTree: CallTree<CpuProCategory>
) {
    // merge samples
    const mergeSamplesStart = Date.now();
    const { samples, timeDeltas } = mergeSamples(rawSamples, rawTimeDeltas);
    TIMINGS && console.log('merge samples', Date.now() - mergeSamplesStart);

    // re-map samples
    const remapSamplesStart = Date.now();
    let sampleIdToNode = remapSamples(samples, callFramesTree.sourceIdToNode);
    callFramesTree.sampleIdToNode = sampleIdToNode;

    for (const tree of [functionsTree, modulesTree, packagesTree, categoriesTree] as const) {
        tree.sampleIdToNode = sampleIdToNode.map(id => tree.sourceIdToNode[id]);
        sampleIdToNode = tree.sampleIdToNode;
    }

    TIMINGS && console.log('re-map samples', Date.now() - remapSamplesStart);

    // create timings
    const computeTimingsStart = Date.now();
    const names = ['functions', 'modules', 'packages', 'categories'];
    const {
        samplesTimings,
        samplesTimingsFiltered,
        treeTimings,
        treeTimingsFiltered,
        dictionaryTimings,
        dictionaryTimingsFiltered
    } = createTreeCompute(samples, timeDeltas, [
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    ]);

    const result = {
        samplesTimings,
        samplesTimingsFiltered
    };

    dictionaryTimings.forEach((timings, i) => result[`${names[i]}Timings`] = timings);
    treeTimings.forEach((timings, i) => result[`${names[i]}TreeTimings`] = timings);
    dictionaryTimingsFiltered.forEach((timings, i) => result[`${names[i]}TimingsFiltered`] = timings);
    treeTimingsFiltered.forEach((timings, i) => result[`${names[i]}TreeTimingsFiltered`] = timings);

    TIMINGS && console.log('Compute timings:', Date.now() - computeTimingsStart);

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
