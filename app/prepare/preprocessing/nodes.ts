import type { V8CpuProfileNode, V8CpuProfileCallFrame, IProfileScriptsMap, GeneratedNodes } from '../types';
import type { Dictionary } from '../dictionary';
import { findMaxId } from '../utils';

export function mapNodes(
    dict: Dictionary,
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    callFrameByIndex: Uint32Array,
    scriptsMap: IProfileScriptsMap,
    generatedNodes: GeneratedNodes | null = null
) {
    const generatedNodesCount: number = generatedNodes?.count || 0;
    const callFrameByNodeIndex = new Uint32Array(nodes.length + generatedNodesCount);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        const { callFrame } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? callFrameByIndex[callFrame]
            : dict.resolveCallFrameIndex(callFrame, scriptsMap);

        callFrameByNodeIndex[i] = callFrameIndex;
    }

    // generatedNodes
    callFrameByNodeIndex.set(generatedNodes?.callFrames || [], nodes.length);

    return callFrameByNodeIndex;
}

export function createNodeIndexById(
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    generatedNodes: GeneratedNodes | null = null
) {
    const maxNodeId: number = findMaxId(nodes);
    const generatedNodesCount: number = generatedNodes?.count || 0;
    const nodeIndexById = new Int32Array(maxNodeId + 1 + generatedNodesCount).fill(-1);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        nodeIndexById[nodes[i].id] = i;
    }

    // generatedNodes
    for (let i = nodes.length, id = maxNodeId + 1; i < nodeIndexById.length; i++, id++) {
        nodeIndexById[id] = i;
    }

    return nodeIndexById;
}

export function createNodePositions(
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    generatedNodes: GeneratedNodes | null = null
) {
    const generatedNodePositions: number[] = generatedNodes?.parentScriptOffsets || [];
    const nodePositions = new Int32Array(nodes.length + generatedNodePositions.length).fill(-1);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        const { parentScriptOffset } = nodes[i];

        if (typeof parentScriptOffset === 'number') {
            nodePositions[i] = parentScriptOffset;
        }
    }

    // generated nodes
    nodePositions.set(generatedNodePositions, nodes.length);

    return nodePositions;
}

export function createNodeParent(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    nodeIndexById: Int32Array,
    generatedNodes: GeneratedNodes | null = null
) {
    const generatedNodesParentId = generatedNodes?.nodeParentId || [];
    const nodeParent = new Uint32Array(nodes.length + generatedNodesParentId.length);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        const { children } = nodes[i];

        if (Array.isArray(children) && children.length > 0) {
            for (const childId of children) {
                nodeParent[nodeIndexById[childId]] = i;
            }
        }
    }

    // generatedNodes
    for (let i = 0, k = nodes.length; i < generatedNodesParentId.length; i++, k++) {
        nodeParent[k] = nodeIndexById[generatedNodesParentId[i]];
    }

    return nodeParent;
}

export function processNodes(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    generatedNodes: GeneratedNodes | null = null
) {
    const nodeIndexById = createNodeIndexById(nodes, generatedNodes);
    const nodeParent = createNodeParent(nodes, nodeIndexById, generatedNodes);
    const nodePositions = createNodePositions(nodes, generatedNodes);

    return {
        nodeIndexById,
        nodeParent,
        nodePositions
    };
}
