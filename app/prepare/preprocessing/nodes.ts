import type { V8CpuProfileNode, V8CpuProfileCallFrame, IProfileScriptsMap } from '../types';
import type { Dictionary } from '../dictionary';
import { findMaxId } from '../misc/utils';

export class GeneratedNodes {
    dict: Dictionary;
    nodeIndexSeed: number;
    noSamplesNodeId: number;
    callFrames: number[];
    nodeParentId: number[];
    parentScriptOffsets: number[];

    constructor(dict: Dictionary, nodeIndexSeedStart: number = 0) {
        this.dict = dict;
        this.nodeIndexSeed = nodeIndexSeedStart;
        this.noSamplesNodeId = -1;
        this.callFrames = [];
        this.nodeParentId = [];
        this.parentScriptOffsets = [];
    }

    addNode(callFrameIndex: number, parentId: number, parentScriptOffset: number) {
        const index = this.nodeIndexSeed++;

        this.callFrames.push(callFrameIndex);
        this.nodeParentId.push(parentId);
        this.parentScriptOffsets.push(parentScriptOffset);

        return index;
    }

    get count() {
        return this.nodeParentId.length;
    }
}

export function createNodesCallFrameIndex(
    dict: Dictionary,
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    callFrameByIndex: Uint32Array,
    scriptsMap: IProfileScriptsMap,
    generatedNodes: GeneratedNodes | null = null
) {
    const generatedNodesCallFrames = generatedNodes?.callFrames || [];
    const callFrameByNodeIndex = new Uint32Array(nodes.length + generatedNodesCallFrames.length);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        const { callFrame } = nodes[i];
        const callFrameIndex = typeof callFrame === 'number'
            ? callFrameByIndex[callFrame]
            : dict.resolveCallFrameIndex(callFrame, scriptsMap, true);

        callFrameByNodeIndex[i] = callFrameIndex;
    }

    // generatedNodes
    callFrameByNodeIndex.set(generatedNodesCallFrames, nodes.length);

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

    // generatedNodes.nodeParentId already resolved into node indices, just set them in place
    nodeParent.set(generatedNodesParentId, nodes.length);

    return nodeParent;
}

export function createNodeLocations(
    nodes: V8CpuProfileNode<V8CpuProfileCallFrame | number>[],
    nodeParent: Uint32Array,
    generatedNodes: GeneratedNodes | null = null,
    callFrameByNodeIndex: Uint32Array,
    dict: Dictionary
) {
    const generatedNodeLocations: number[] = generatedNodes?.parentScriptOffsets || [];
    const nodeLocations = new Int32Array(nodes.length + generatedNodeLocations.length).fill(-1);

    // nodes
    for (let i = 0; i < nodes.length; i++) {
        const {
            parentScriptOffset,
            parentLineNumber = -1,
            parentColumnNumber = -1
        } = nodes[i];

        if (typeof parentScriptOffset === 'number') {
            nodeLocations[i] = parentScriptOffset;
        } else {
            if (parentLineNumber !== -1 && parentColumnNumber !== -1 && nodeParent[i] > 0) {
                nodeLocations[i] = dict.resolveLocation(
                    dict.callFrames[callFrameByNodeIndex[nodeParent[i]]],
                    null,
                    -1,
                    parentLineNumber,
                    parentColumnNumber,
                    true
                ).scriptOffset;
            }
        }
    }

    // generated nodes
    nodeLocations.set(generatedNodeLocations, nodes.length);

    return nodeLocations;
}
