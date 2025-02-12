import type { GeneratedNodes, V8CpuProfileCallFrame, V8CpuProfileNode } from '../types.js';

// The distribution of GC samples based on their position in the previous call frame appears too arbitrary.
// As a result, GC samples (typically the smaller ones) are allocated within the function code as nested operations,
// which creates noise and can be misleading. This is because the placement of GC samples within a function is speculative
// (GC might have triggered outside the function, and certainly not at the last recorded location).
// The optimal solution at present is to assign GC samples to the call frame without considering their position.
// Tracking of positions can be enabled via this flag for future experiments.
const useSamplePositions = false;

export function reparentGcNodes(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    generatedNodes: GeneratedNodes,
    callFrames: V8CpuProfileCallFrame[] | null,
    samples: Uint32Array,
    samplePositions: Int32Array | null
) {
    const rootGcNodeId = callFrames !== null
        ? findRootGcNodeIdWithCallFrames(nodes, callFrames)
        : findRootGcNodeId(nodes as V8CpuProfileNode[]);

    if (rootGcNodeId === -1) {
        return;
    }

    if (useSamplePositions && samplePositions !== null) {
        remapGcSamplesWithPositions(rootGcNodeId, generatedNodes, samples, samplePositions);
    } else {
        remapGcSamples(rootGcNodeId, generatedNodes, samples);
    }
}

function remapGcSamples(
    gcNodeId: number,
    generatedNodes: GeneratedNodes,
    samples: Uint32Array
) {
    const nodeIdToGcNodeId = new Map<number, number>();
    const { nodeParentId, noSamplesNodeId, parentScriptOffsets, callFrames, dict } = generatedNodes;
    const gcCallFrameIndex = dict.callFrames.wellKnownIndex.gc;

    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else if (prevNodeId !== noSamplesNodeId) {
                let newGcNodeId = nodeIdToGcNodeId.get(prevNodeId);

                if (newGcNodeId === undefined) {
                    newGcNodeId = generatedNodes.nodeIdSeed++;
                    nodeIdToGcNodeId.set(prevNodeId, newGcNodeId);

                    callFrames.push(gcCallFrameIndex);
                    nodeParentId.push(prevNodeId);
                    parentScriptOffsets.push(-1);
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }
}

function remapGcSamplesWithPositions(
    gcNodeId: number,
    generatedNodes: GeneratedNodes,
    samples: Uint32Array,
    samplePositions: Int32Array
) {
    const maxNodeId = generatedNodes.nodeIdSeed;
    const nodeIdToGcNodeId = new Map<number, number>();
    const { nodeParentId, noSamplesNodeId, parentScriptOffsets, callFrames, dict } = generatedNodes;
    const gcCallFrameIndex = dict.callFrames.wellKnownIndex.gc;

    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else if (prevNodeId !== noSamplesNodeId) {
                const prevNodeScriptOffset = samplePositions[i - 1];
                const prevNodeRef = prevNodeScriptOffset * maxNodeId + prevNodeId;
                let newGcNodeId = nodeIdToGcNodeId.get(prevNodeRef);

                if (newGcNodeId === undefined) {
                    newGcNodeId = generatedNodes.nodeIdSeed++;
                    nodeIdToGcNodeId.set(prevNodeRef, newGcNodeId);

                    callFrames.push(gcCallFrameIndex);
                    nodeParentId.push(prevNodeId);
                    parentScriptOffsets.push(prevNodeScriptOffset);
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }
}

function findRootGcNodeIdWithCallFrames(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames: V8CpuProfileCallFrame[]
) {
    const rootChildren = new Set(nodes[0].children);

    for (const node of nodes) {
        const callFrameOrIndex = node.callFrame;
        const callFrame = typeof callFrameOrIndex === 'number'
            ? callFrames[callFrameOrIndex]
            : callFrameOrIndex;

        if (callFrame.scriptId === 0 &&
            callFrame.functionName === '(garbage collector)' &&
            rootChildren.has(node.id)) {
            return node.id;
        }
    }

    return -1;
}

function findRootGcNodeId(nodes: V8CpuProfileNode[]) {
    const rootChildren = new Set(nodes[0].children);

    for (const node of nodes) {
        const callFrame = node.callFrame;

        if (callFrame.scriptId === 0 &&
            callFrame.functionName === '(garbage collector)' &&
            rootChildren.has(node.id)) {
            return node.id;
        }
    }

    return -1;
}

