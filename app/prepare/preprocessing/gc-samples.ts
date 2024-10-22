import type { GeneratedNodes, V8CpuProfileCallFrame, V8CpuProfileNode } from '../types.js';

export function reparentGcNodes(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames: V8CpuProfileCallFrame[] | null,
    samples: Uint32Array,
    samplePositions: Int32Array | null
): GeneratedNodes | null {
    const maxNodeId = nodes.length - 1;
    const rootGcNodeId = callFrames !== null
        ? findRootGcNodeIdWithCallFrames(nodes, callFrames)
        : findRootGcNodeId(nodes as V8CpuProfileNode[]);

    if (rootGcNodeId !== -1) {
        return samplePositions !== null
            ? remapGcSamplesWithPositions(maxNodeId, rootGcNodeId, samples, samplePositions)
            : remapGcSamples(maxNodeId, rootGcNodeId, samples);
    }

    return null;
}

function remapGcSamples(
    nodeIdSeed: number,
    gcNodeId: number,
    samples: Uint32Array
) {
    const nodeIdToGcNodeId = new Map<number, number>();

    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else {
                let newGcNodeId = nodeIdToGcNodeId.get(prevNodeId);

                if (newGcNodeId === undefined) {
                    newGcNodeId = ++nodeIdSeed;
                    nodeIdToGcNodeId.set(prevNodeId, newGcNodeId);
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }

    const nodeParentId = [...nodeIdToGcNodeId.keys()];

    return {
        count: nodeParentId.length,
        nodeParentId,
        parentScriptOffsets: null
    };
}

function remapGcSamplesWithPositions(
    nodeIdSeed: number,
    gcNodeId: number,
    samples: Uint32Array,
    samplePositions: Int32Array
) {
    const maxNodeId = nodeIdSeed + 1;
    const nodeIdToGcNodeId = new Map<number, number>();
    const nodeParentId: number[] = [];
    const parentScriptOffsets: number[] = [];

    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                samples[i] = samples[i - 1];
            } else {
                const prevNodeScriptOffset = samplePositions[i - 1];
                const prevNodeRef = prevNodeScriptOffset * maxNodeId + prevNodeId;
                let newGcNodeId = nodeIdToGcNodeId.get(prevNodeRef);

                if (newGcNodeId === undefined) {
                    newGcNodeId = ++nodeIdSeed;
                    nodeIdToGcNodeId.set(prevNodeRef, newGcNodeId);
                    nodeParentId.push(prevNodeId);
                    parentScriptOffsets.push(prevNodeScriptOffset);
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }

    return {
        count: nodeParentId.length,
        nodeParentId,
        parentScriptOffsets
    };
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

