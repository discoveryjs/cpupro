import { CallTree } from './call-tree';
import { Dictionary } from './dictionary';
import { V8CpuProfileNode, V8CpuProfileCallFrame, CpuProCallFrame } from './types';
import { findMaxId } from './utils';

function buildCallFrameTree(
    nodeId: number,
    nodeChildren: (number[] | null)[],
    callFrameByNodeIndex: Uint32Array,
    sourceIdToNode: Int32Array,
    nodes: Uint32Array,
    parent: Uint32Array,
    subtreeSize: Uint32Array,
    cursor = 0
) {
    function visitNode(nodeId: number) {
        const idx = sourceIdToNode[nodeId];
        const children = nodeChildren[idx];
        const nodeIndex = cursor++;

        nodes[nodeIndex] = callFrameByNodeIndex[idx];
        sourceIdToNode[nodeId] = nodeIndex;

        if (children !== null) {
            for (const childId of children) {
                parent[cursor] = nodeIndex;
                visitNode(childId);
            }

            subtreeSize[nodeIndex] = cursor - nodeIndex - 1;
        }
    }

    visitNode(nodeId);
}

function tempBuildCallFrameTree(
    callFrames: CpuProCallFrame[],
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    nodeIndexById: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    nodeIdToGcNodeId: Uint32Array
) {
    const t = Date.now();
    const callFramesTree = new CallTree(callFrames, nodeIndexById.slice(), new Uint32Array(nodeIndexById.length));

    const nodeChildren: (number[] | null)[] = new Array(nodeIndexById.length).fill(null);

    for (let i = 0; i < nodes.length; i++) {
        const { id, children } = nodes[i];
        const gcNodeId = nodeIdToGcNodeId[id];

        if (Array.isArray(children) && children.length > 0) {
            nodeChildren[i] = gcNodeId === 0 ? children : children.concat(gcNodeId);
        } else if (gcNodeId !== 0) {
            nodeChildren[i] = [gcNodeId];
        }
    }

    buildCallFrameTree(
        nodes[0].id,
        nodeChildren,
        callFrameByNodeIndex,
        callFramesTree.sourceIdToNode, // pass arrays as separate values to reduce property reads, good for performance
        callFramesTree.nodes,
        callFramesTree.parent,
        callFramesTree.subtreeSize
    );
    console.log(Date.now() - t);

    return callFramesTree;
}

function gcReparenting2(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames: CpuProCallFrame[],
    samples: Uint32Array,
    callFrameByNodeIndex: Uint32Array,
    nodeIndexById: Int32Array,
    nodeParent: Uint32Array
) {
    const gcCallFrameIndex = callFrames.findIndex(cf => cf.scriptId === 0 && cf.functionName === '(garbage collector)');
    const rootGcNodeId = gcCallFrameIndex !== -1
        ? nodes[0].children?.find(id => callFrameByNodeIndex[id - 1] === gcCallFrameIndex)
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
    inputCallFrames: V8CpuProfileCallFrame[] | null = null,
    samples_: Uint32Array
) {
    const samples = samples_.slice();
    const callFrames = dict.callFrames;
    const callFrameByNodeIndex = new Uint32Array(nodes.length);
    const maxNodeId: number = findMaxId(nodes);
    const nodeIndexById = new Int32Array(maxNodeId + 1).fill(-1);

    // console.log(nodes[0].id === 1, nodes[nodes.length - 1].id === nodes.length);

    const inputCallFramesMap = new Uint32Array(inputCallFrames?.length || 0);
    if (inputCallFrames !== null) {
        for (let i = 0; i < inputCallFrames.length; i++) {
            inputCallFramesMap[i] = dict.resolveCallFrameIndex(inputCallFrames[i]);
        }

        // FIXME
        if (inputCallFrames.length !== callFrames.length) {
            console.warn('Merged call frames:', inputCallFrames.length - callFrames.length);
        }
    }

    for (let i = 0; i < nodes.length; i++) {
        const { id, callFrame } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? inputCallFramesMap[callFrame]
            : dict.resolveCallFrameIndex(callFrame);

        nodeIndexById[id] = i;
        callFrameByNodeIndex[i] = callFrameIndex;
    }

    const nodeParent = buildNodeParent(nodes, nodeIndexById);

    const reparented = gcReparenting2(
        nodes,
        callFrames,
        samples,
        callFrameByNodeIndex,
        nodeIndexById,
        nodeParent
    );

    const callFramesTree = false ? tempBuildCallFrameTree(
        callFrames,
        nodes,
        reparented.nodeIndexById,
        reparented.callFrameByNodeIndex,
        reparented.nodeIdToGcNodeId
    ) : undefined;

    return {
        nodeParent: reparented.nodeParent,
        nodeIndexById: reparented.nodeIndexById,
        callFrameByNodeIndex: reparented.callFrameByNodeIndex,
        callFrames,
        callFramesTree
    };
}
