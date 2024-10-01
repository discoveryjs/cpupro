import { CallTree } from './call-tree';
import { TIMINGS } from './const';
import { createCpuProFrame } from './process-call-frames';
import { V8CpuProfileNode, V8CpuProfileCallFrame, CpuProCallFrame } from './types';
import { findMaxId } from './utils';

type CallFrameMap = Map<
    number, // scriptId
    Map<
        string, // function name
        Map<
            number, // line
            Map<
                number, // column
                CpuProCallFrame
            >
        >
    >
>;

const scriptIdFromString = new Map<string, number>();

function normalizeLoc(value: unknown) {
    return typeof value === 'number' && value >= 0 ? value : -1;
}

function getCallFrame(
    callFrame: V8CpuProfileCallFrame,
    callFrames: CpuProCallFrame[],
    byScriptIdMap: CallFrameMap
) {
    const functionName = callFrame.functionName || '';
    const lineNumber = normalizeLoc(callFrame.lineNumber);
    const columnNumber = normalizeLoc(callFrame.columnNumber);
    const url = callFrame.url || null;
    let scriptId = callFrame.scriptId;

    // ensure scriptId is a number
    // some tools are generating scriptId as a stringified number
    if (typeof scriptId === 'string') {
        if (/^\d+$/.test(scriptId)) {
            // the simplest case: a stringified number, convert it to a number
            scriptId = Number(scriptId);
        } else {
            // handle cases where scriptId is represented as an URL or a string in the format ":number"
            let numericScriptId = scriptIdFromString.get(scriptId);

            if (numericScriptId === undefined) {
                scriptIdFromString.set(scriptId, numericScriptId = /^:\d+$/.test(scriptId)
                    ? Number(scriptId.slice(1))
                    : -scriptIdFromString.size - 1
                );
            }

            scriptId = numericScriptId;
        }
    }

    // resolve a callFrame through a chain of maps
    let byFunctionNameMap = byScriptIdMap.get(scriptId);
    if (byFunctionNameMap === undefined) {
        byScriptIdMap.set(scriptId, byFunctionNameMap = new Map());
    }

    let byLineNumberMap = byFunctionNameMap.get(functionName);
    if (byLineNumberMap === undefined) {
        byFunctionNameMap.set(functionName, byLineNumberMap = new Map());
    }

    let resultMap = byLineNumberMap.get(lineNumber);
    if (resultMap === undefined) {
        byLineNumberMap.set(lineNumber, resultMap = new Map());
    }

    let result = resultMap.get(columnNumber);
    if (result === undefined) {
        result = createCpuProFrame(
            callFrames.length + 1,
            scriptId,
            url,
            functionName,
            lineNumber,
            columnNumber
        );

        callFrames.push(result);
        resultMap.set(columnNumber, result);
    }

    return result;
}

function addCallFrame(
    callFrame: V8CpuProfileCallFrame,
    callFrames: CpuProCallFrame[],
    callFramesMap: CallFrameMap
): number {
    return getCallFrame(
        callFrame,
        callFrames,
        callFramesMap
    ).id - 1;
}

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
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    inputCallFrames: V8CpuProfileCallFrame[] | null = null,
    samples_: Uint32Array
) {
    const samples = samples_.slice();
    const callFramesMap: CallFrameMap = new Map();
    const callFrames: CpuProCallFrame[] = [];
    let callFrameByNodeIndex = new Uint32Array(nodes.length);
    const maxNodeId: number = findMaxId(nodes);
    let nodeIndexById = new Uint32Array(maxNodeId + 1);

    // console.log(nodes[0].id === 1, nodes[nodes.length - 1].id === nodes.length);

    const inputCallFramesMap = new Uint32Array(inputCallFrames?.length || 0);
    if (inputCallFrames !== null) {
        for (let i = 0; i < inputCallFrames.length; i++) {
            inputCallFramesMap[i] = addCallFrame(inputCallFrames[i], callFrames, callFramesMap);
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
            : addCallFrame(callFrame, callFrames, callFramesMap);

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
