import { CallTree } from './call-tree';
import { TIMINGS } from './const';
import {
    V8CpuProfileNode,
    V8CpuProfileCallFrame,
    CpuProCallFrame,
    CpuProCategory,
    CpuProPackage,
    CpuProModule,
    CpuProFunction
} from './types';

type CallFrameMap = Map<
    number, // scriptId
    Map<
        string | null, // url
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
    >
>;

const scriptIdFromString = new Map<string, number>();

function normalizeLoc(value: unknown) {
    return typeof value === 'number' && value >= 0 ? value : -1;
}

function getCallFrame(
    callFrame: V8CpuProfileCallFrame,
    callFrames: CpuProCallFrame[],
    byScriptIdMap: CallFrameMap,
    urlByScriptId: Map<number, string>
) {
    const functionName = callFrame.functionName || '';
    const lineNumber = normalizeLoc(callFrame.lineNumber);
    const columnNumber = normalizeLoc(callFrame.columnNumber);
    let scriptId = callFrame.scriptId;
    let url = callFrame.url || null;

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

    // address a known issue where some callFrames lack a URL;
    // if a URL exists, associate it with its scriptId for reference
    if (url !== null) {
        urlByScriptId.set(scriptId, url);
    } else if (scriptId !== 0) {
        url = urlByScriptId.get(scriptId) || '';
    }

    // resolve a callFrame through a chain of maps
    let byUrlMap = byScriptIdMap.get(scriptId);
    if (byUrlMap === undefined) {
        byScriptIdMap.set(scriptId, byUrlMap = new Map());
    }

    let byFunctionNameMap = byUrlMap.get(url);
    if (byFunctionNameMap === undefined) {
        byUrlMap.set(url, byFunctionNameMap = new Map());
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
        result = {
            id: callFrames.length + 1,
            scriptId,
            url,
            functionName,
            lineNumber,
            columnNumber,
            // these field will be populated on call frames processing step
            category: null as unknown as CpuProCategory,
            package: null as unknown as CpuProPackage,
            module: null as unknown as CpuProModule,
            function: null as unknown as CpuProFunction
        };

        callFrames.push(result);
        resultMap.set(columnNumber, result);
    }

    return result;
}

function buildCallFrameTree(
    nodeId: number,
    sourceNodes: V8CpuProfileNode[],
    sourceIdToNode: Uint32Array,
    nodes: Uint32Array,
    parent: Uint32Array,
    subtreeSize: Uint32Array,
    cursor = 0
) {
    const idx = sourceIdToNode[nodeId];
    const node = sourceNodes[idx];
    const nodeIndex = cursor++;

    nodes[nodeIndex] = idx;
    sourceIdToNode[nodeId] = nodeIndex;

    if (Array.isArray(node.children) && node.children.length > 0) {
        for (const childId of node.children) {
            parent[cursor] = nodeIndex;
            cursor = buildCallFrameTree(
                childId,
                sourceNodes,
                sourceIdToNode,
                nodes,
                parent,
                subtreeSize,
                cursor
            );
        }

        subtreeSize[nodeIndex] = cursor - nodeIndex - 1;
    }

    return cursor;
}

export function processNodes(nodes: V8CpuProfileNode[], maxNodeId: number) {
    const initStart = Date.now();
    const urlByScriptId = new Map<number, string>();
    const callFramesMap: CallFrameMap = new Map();
    const callFrames: CpuProCallFrame[] = [];
    const nodeById = new Uint32Array(maxNodeId + 1);
    const nodesCount = nodes.length;

    for (let i = 0; i < nodesCount; i++) {
        nodeById[nodes[i].id] = i;
    }

    if (TIMINGS) {
        console.log('>> init processNodes', Date.now() - initStart);
    }

    const buildTreeStart = Date.now();
    const callFramesTree = new CallTree(callFrames, nodeById, new Uint32Array(nodesCount));
    buildCallFrameTree(
        nodes[0].id,
        nodes,
        callFramesTree.sourceIdToNode, // pass arrays as separate values to reduce property reads, good for performance
        callFramesTree.nodes,
        callFramesTree.parent,
        callFramesTree.subtreeSize
    );
    if (TIMINGS) {
        console.log('>> buildCallFrameTree()', Date.now() - buildTreeStart);
    }

    const dedupCallFramesStart = Date.now();
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[callFramesTree.nodes[i]];
        const callFrame = getCallFrame(
            node.callFrame,
            callFrames,
            callFramesMap,
            urlByScriptId
        );

        callFramesTree.nodes[i] = callFrame.id - 1;
    }
    if (TIMINGS) {
        console.log('>> dedup call frames', Date.now() - dedupCallFramesStart);
    }

    return {
        callFrames,
        callFramesTree
    };
}
