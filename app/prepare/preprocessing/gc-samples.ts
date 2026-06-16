import type { V8CpuProfileCallFrame, V8CpuProfileNode } from '../types.js';
import { GeneratedNodes } from './nodes.js';

// The distribution of GC samples based on their location in the previous call frame appears too arbitrary.
// As a result, GC samples (typically the smaller ones) are allocated within the function code as nested operations,
// which creates noise and can be misleading. This is because the placement of GC samples within a function is speculative
// (GC might have triggered outside the function, and certainly not at the last recorded location).
// The optimal solution at present is to assign GC samples to the call frame without considering their location.
// Tracking of locations can be enabled via this flag for future experiments.
const useSampleLocations = false;

export function reparentGcNodes(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    generatedNodes: GeneratedNodes,
    callFrames: V8CpuProfileCallFrame[] | null,
    samples: Uint32Array,
    sampleScriptOffsets: Int32Array | null
) {
    const rootGcNodeIndex = callFrames !== null
        ? findRootGcNodeIdWithCallFrames(nodes, callFrames)
        : findRootGcNodeId(nodes as V8CpuProfileNode[]);

    if (rootGcNodeIndex === -1) {
        return;
    }

    if (useSampleLocations && sampleScriptOffsets !== null) {
        remapGcSamplesWithScriptOffsets(rootGcNodeIndex, generatedNodes, samples, sampleScriptOffsets);
    } else {
        remapGcSamples(rootGcNodeIndex, generatedNodes, samples);
    }
}

function remapGcSamples(
    gcNodeIndex: number,
    generatedNodes: GeneratedNodes,
    samples: Uint32Array
) {
    const sampleToGcNode = new Map<number, number>();
    const { noSamplesNodeId, dict } = generatedNodes;
    const gcCallFrameIndex = dict.callFrames.wellKnownIndex.gc;

    for (let i = 1, prevNodeIndex = samples[0]; i < samples.length; i++) {
        const nodeIndex = samples[i];

        if (nodeIndex === gcNodeIndex) {
            if (prevNodeIndex === gcNodeIndex) {
                samples[i] = samples[i - 1];
            } else if (prevNodeIndex !== noSamplesNodeId) {
                let newGcNodeId = sampleToGcNode.get(prevNodeIndex);

                if (newGcNodeId === undefined) {
                    sampleToGcNode.set(prevNodeIndex, newGcNodeId = generatedNodes.addNode(
                        gcCallFrameIndex,
                        prevNodeIndex,
                        -1
                    ));
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeIndex = nodeIndex;
    }
}

function remapGcSamplesWithScriptOffsets(
    gcNodeIndex: number,
    generatedNodes: GeneratedNodes,
    samples: Uint32Array,
    sampleScriptOffsets: Int32Array
) {
    const sampleToGcNode = new Map<number, number>();
    const { nodeIndexSeed: maxNodeIndex, noSamplesNodeId, dict } = generatedNodes;
    const gcCallFrameIndex = dict.callFrames.wellKnownIndex.gc;

    for (let i = 1, prevNodeIndex = samples[0]; i < samples.length; i++) {
        const nodeIndex = samples[i];

        if (nodeIndex === gcNodeIndex) {
            if (prevNodeIndex === gcNodeIndex) {
                samples[i] = samples[i - 1];
            } else if (prevNodeIndex !== noSamplesNodeId) {
                const prevNodeScriptOffset = sampleScriptOffsets[i - 1];
                const prevNodeRef = prevNodeScriptOffset * maxNodeIndex + prevNodeIndex;
                let newGcNodeId = sampleToGcNode.get(prevNodeRef);

                if (newGcNodeId === undefined) {
                    sampleToGcNode.set(prevNodeRef, newGcNodeId = generatedNodes.addNode(
                        gcCallFrameIndex,
                        prevNodeIndex,
                        prevNodeScriptOffset
                    ));
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeIndex = nodeIndex;
    }
}

function findRootGcNodeIdWithCallFrames(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames: V8CpuProfileCallFrame[]
) {
    const rootChildren = new Set(nodes[0].children);

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const callFrameOrIndex = node.callFrame;
        const callFrame = typeof callFrameOrIndex === 'number'
            ? callFrames[callFrameOrIndex]
            : callFrameOrIndex;

        if (callFrame.scriptId === 0 &&
            callFrame.functionName === '(garbage collector)' &&
            rootChildren.has(node.id)) {
            return i;
        }
    }

    return -1;
}

function findRootGcNodeId(nodes: V8CpuProfileNode[]) {
    const rootChildren = new Set(nodes[0].children);

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const callFrame = node.callFrame;

        if (callFrame.scriptId === 0 &&
            callFrame.functionName === '(garbage collector)' &&
            rootChildren.has(node.id)) {
            return i;
        }
    }

    return -1;
}
