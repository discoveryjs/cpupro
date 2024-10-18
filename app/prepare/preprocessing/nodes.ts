import type { V8CpuProfileNode, V8CpuProfileCallFrame, IScriptMapper } from '../types';
import type { ReparentGcNodesResult } from './gc-samples';
import type { Dictionary } from '../dictionary';
import { findMaxId } from '../utils';

export function mapNodes(
    dict: Dictionary,
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    callFrameByIndex: Uint32Array,
    scriptMapper: IScriptMapper,
    gcNodes?: ReparentGcNodesResult | null
) {
    const gcNodesCount: number = gcNodes?.nodeParent.length || 0;
    const callFrameByNodeIndex = new Uint32Array(nodes.length + gcNodesCount);

    callFrameByNodeIndex.fill(dict.callFrames.wellKnownIndex.gc, nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        const { callFrame } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? callFrameByIndex[callFrame]
            : dict.resolveCallFrameIndex(callFrame, scriptMapper);

        callFrameByNodeIndex[i] = callFrameIndex;
    }

    return callFrameByNodeIndex;
}

export function createNodeIndexById(
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    gcNodes?: ReparentGcNodesResult | null
) {
    const maxNodeId: number = findMaxId(nodes);
    const gcNodesCount: number = gcNodes?.nodeParent.length || 0;
    const nodeIndexById = new Int32Array(maxNodeId + 1 + gcNodesCount).fill(-1);

    for (let i = 0; i < nodes.length; i++) {
        nodeIndexById[nodes[i].id] = i;
    }

    if (gcNodesCount > 0) {
        for (let id = nodes.length; id <= nodeIndexById.length; id++) {
            nodeIndexById[id] = id - 1;
        }
    }

    return nodeIndexById;
}

export function createNodeParent(
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    nodeIndexById: Int32Array,
    gcNodes?: ReparentGcNodesResult | null
) {
    const gcNodesParent = gcNodes?.nodeParent || [];
    const nodeParent = new Uint32Array(nodes.length + gcNodesParent.length);

    nodeParent.set(gcNodesParent, nodes.length);

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
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    gcNodes?: ReparentGcNodesResult | null
) {
    const nodeIndexById = createNodeIndexById(nodes, gcNodes);
    const nodeParent = createNodeParent(nodes, nodeIndexById, gcNodes);

    return {
        nodeIndexById,
        nodeParent
    };
}
