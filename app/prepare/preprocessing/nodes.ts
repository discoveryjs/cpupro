import type { V8CpuProfileNode, V8CpuProfileCallFrame, CpuProCallFrame, IScriptMapper } from '../types';
import type { Dictionary } from '../dictionary';
import { findMaxId } from '../utils';

export function mapNodes(
    dict: Dictionary,
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    callFrameByIndex: Uint32Array,
    scriptMapper: IScriptMapper
) {
    const maxNodeId: number = findMaxId(nodes);
    const nodeIndexById = new Int32Array(maxNodeId + 1).fill(-1);
    const callFrameByNodeIndex = new Uint32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        const { id, callFrame } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? callFrameByIndex[callFrame]
            : dict.resolveCallFrameIndex(callFrame, scriptMapper);

        nodeIndexById[id] = i;
        callFrameByNodeIndex[i] = callFrameIndex;
    }

    return {
        nodeIndexById,
        callFrameByNodeIndex
    };
}

function gcReparenting2(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames: CpuProCallFrame[],
    samples: Uint32Array,
    callFrameByNodeIndex: Uint32Array,
    nodeIndexById: Int32Array,
    nodeParent: Uint32Array
) {
    const gcCallFrameIndex = callFrames.findIndex(cf => cf.script === null && cf.name === '(garbage collector)');
    const rootGcNodeId = gcCallFrameIndex !== -1
        ? nodes[0].children?.find(id => callFrameByNodeIndex[nodeIndexById[id]] === gcCallFrameIndex)
        : -1;

    const maxNodeId = nodeIndexById.length - 1;
    const nodeIdToGcNodeId = new Uint32Array(maxNodeId + 1);
    let addedGcNodeId = maxNodeId;
    for (let i = 1, prevNodeId = samples[0]; i < samples.length; i++) {
        const nodeId = samples[i];

        if (nodeId === rootGcNodeId) {
            if (prevNodeId === rootGcNodeId) {
                samples[i] = samples[i - 1];
            } else {
                let newGcNodeId = nodeIdToGcNodeId[prevNodeId];

                if (newGcNodeId === 0) {
                    newGcNodeId = ++addedGcNodeId;
                    nodeIdToGcNodeId[prevNodeId] = newGcNodeId;
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }

    if (addedGcNodeId !== maxNodeId) {
        const addedGcNodeCount = addedGcNodeId - maxNodeId;
        const newCallFrameByNodeIndex = new Uint32Array(callFrameByNodeIndex.length + addedGcNodeCount);
        const newNodeIndexById = new Int32Array(nodeIndexById.length + addedGcNodeCount);
        const newNodeParent = new Uint32Array(nodeParent.length + addedGcNodeCount);

        newCallFrameByNodeIndex.set(callFrameByNodeIndex);
        newCallFrameByNodeIndex.fill(gcCallFrameIndex, -addedGcNodeCount);

        newNodeIndexById.set(nodeIndexById);
        for (let id = addedGcNodeId - addedGcNodeCount; id <= addedGcNodeId; id++) {
            newNodeIndexById[id] = id - 1;
        }

        const gcNodeParent = new Uint32Array(addedGcNodeId - maxNodeId);
        for (let i = 0, k = 0; i < nodeIdToGcNodeId.length; i++) {
            if (nodeIdToGcNodeId[i] > 0) {
                gcNodeParent[k++] = nodeIndexById[i];
            }
        }

        newNodeParent.set(nodeParent);
        newNodeParent.set(gcNodeParent, nodeParent.length);

        // replace arrays
        callFrameByNodeIndex = newCallFrameByNodeIndex;
        nodeIndexById = newNodeIndexById;
        nodeParent = newNodeParent;
    }

    return {
        nodeIdToGcNodeId,
        callFrameByNodeIndex,
        nodeIndexById,
        nodeParent
    };
}

export function buildNodeParent(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    nodeIndexById: Int32Array
) {
    const nodeParent = new Uint32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        const { children } = nodes[i];

        if (Array.isArray(children) && children.length > 0) {
            for (const childId of children) {
                nodeParent[nodeIndexById[childId]] = i;
            }
        }
    }

    return nodeParent;
}

export function processNodes(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    nodeIndexById: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    samples_: Uint32Array
) {
    const samples = samples_;

    const nodeParent = buildNodeParent(nodes, nodeIndexById);

    const reparented = gcReparenting2(
        nodes,
        dict.callFrames,
        samples,
        callFrameByNodeIndex,
        nodeIndexById,
        nodeParent
    );

    return {
        nodeParent: reparented.nodeParent,
        nodeIndexById: reparented.nodeIndexById,
        callFrameByNodeIndex: reparented.callFrameByNodeIndex
    };
}
