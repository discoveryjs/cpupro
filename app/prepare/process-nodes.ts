import { CallTree } from './call-tree';
import { Dictionary } from './dictionary';
import { V8CpuProfileNode, V8CpuProfileCallFrame } from './types';
import { findMaxId } from './utils';

function buildCallFrameTree(
    nodeId: number,
    nodeChildren: (number[] | null)[],
    callFrameByNodeIndex: Uint32Array,
    sourceIdToNode: Uint32Array,
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

export function processNodes(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    inputCallFrames: V8CpuProfileCallFrame[] | null = null,
    samples_: Uint32Array
) {
    const samples = samples_.slice();
    const callFrames = dict.callFrames;
    let callFrameByNodeIndex = new Uint32Array(nodes.length);
    const maxNodeId: number = findMaxId(nodes);
    let nodeIndexById = new Uint32Array(maxNodeId + 1);

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

    const nodeChildren: (number[] | null)[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const { id, callFrame, children } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? inputCallFramesMap[callFrame]
            : dict.resolveCallFrameIndex(callFrame);

        nodeIndexById[id] = i;
        nodeChildren[i] = Array.isArray(children) && children.length > 0 ? children : null;
        callFrameByNodeIndex[i] = callFrameIndex;
    }

    const gcCallFrameIndex = callFrames.findIndex(cf => cf.scriptId === 0 && cf.functionName === '(garbage collector)');
    const rootGcNodeId = gcCallFrameIndex !== -1
        ? nodes[0].children?.find(id => callFrameByNodeIndex[id - 1] === gcCallFrameIndex)
        : -1;

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

                    const prevNodeChildren = nodeChildren[prevNodeId - 1];
                    nodeChildren[prevNodeId - 1] = prevNodeChildren !== null
                        ? prevNodeChildren.concat(newGcNodeId)
                        : [newGcNodeId];
                }

                samples[i] = newGcNodeId;
            }
        }

        prevNodeId = nodeId;
    }

    if (addedGcNodeId !== maxNodeId) {
        const addedGcNodeCount = addedGcNodeId - maxNodeId;
        const newCallFrameByNodeIndex = new Uint32Array(callFrameByNodeIndex.length + addedGcNodeCount);
        const newNodeIndexById = new Uint32Array(nodeIndexById.length + addedGcNodeCount);

        newCallFrameByNodeIndex.set(callFrameByNodeIndex);
        newCallFrameByNodeIndex.fill(gcCallFrameIndex, -addedGcNodeCount);

        nodeChildren.length += addedGcNodeCount;
        nodeChildren.fill(null, -addedGcNodeCount);

        newNodeIndexById.set(nodeIndexById);
        for (let id = maxNodeId + 1; id <= addedGcNodeId; id++) {
            newNodeIndexById[id] = id - 1;
        }

        // replace arrays
        callFrameByNodeIndex = newCallFrameByNodeIndex;
        nodeIndexById = newNodeIndexById;
    }

    const callFramesTree = new CallTree(callFrames, nodeIndexById, new Uint32Array(nodeIndexById.length));

    buildCallFrameTree(
        nodes[0].id,
        nodeChildren,
        callFrameByNodeIndex,
        callFramesTree.sourceIdToNode, // pass arrays as separate values to reduce property reads, good for performance
        callFramesTree.nodes,
        callFramesTree.parent,
        callFramesTree.subtreeSize
    );

    return {
        callFrameByNodeIndex,
        callFrames,
        callFramesTree
    };
}
