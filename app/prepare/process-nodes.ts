import {
    V8CpuProfile,
    V8CpuProfileNode,
    V8CpuProfileCallFrame,
    CpuProCallFrame
} from './types';

type CallFrameMap = Map<
    string, // function name
    Map<
        number, // scriptId
        Map<
            string | null,
            Map<
                number,
                Map<
                    number,
                    CpuProCallFrame
                >
            >
        >
    >
>;

const scriptIdFromString = new Map<string, number>();

function maxNodesId(nodes: V8CpuProfileNode[]) {
    let maxNodeId = 0;

    for (const { id } of nodes) {
        if (id > maxNodeId) {
            maxNodeId = id;
        }
    }

    return maxNodeId;
}

function normalizeLoc(value: unknown) {
    return typeof value === 'number' && value >= 0 ? value : -1;
}

function getCallFrame(
    callFrame: V8CpuProfileCallFrame,
    callFrames: CpuProCallFrame[],
    map: CallFrameMap,
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
    let byScriptIdMap = map.get(functionName);
    if (byScriptIdMap === undefined) {
        map.set(functionName, byScriptIdMap = new Map());
    }

    let byUrlMap = byScriptIdMap.get(scriptId);
    if (byUrlMap === undefined) {
        byScriptIdMap.set(scriptId, byUrlMap = new Map());
    }

    let byLineNumberMap = byUrlMap.get(url);
    if (byLineNumberMap === undefined) {
        byUrlMap.set(url, byLineNumberMap = new Map());
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
            columnNumber
        };

        callFrames.push(result);
        resultMap.set(columnNumber, result);
    }

    return result;
}

export function processNodes(nodes: V8CpuProfileNode[], samples) {
    const maxNodeId = maxNodesId(nodes);

    const urlByScriptId = new Map<number, string>();
    const callFramesMap: CallFrameMap = new Map();
    const callFrames = [];
    const nodeById = new Uint32Array(maxNodeId + 1);
    const nodesCount = nodes.length;
    const nodeCallFrame = new Uint32Array(nodesCount);
    const nodeParent = new Uint32Array(nodesCount);
    const nodeNext = new Uint32Array(nodesCount);
    const nodeNextSibling = new Uint32Array(nodesCount);
    const x = new Set(samples);

    for (let i = 0; i < nodesCount; i++) {
        nodeById[nodes[i].id] = i;
    }

    for (let i = 0; i < nodesCount; i++) {
        const node = nodes[i];
        const callFrame = getCallFrame(
            node.callFrame,
            callFrames,
            callFramesMap,
            urlByScriptId
        );

        nodeCallFrame[i] = callFrame.id - 1;

        if (Array.isArray(node.children) && node.children.length) {
            let prevChildIndex = -1;
            for (const childId of node.children) {
                const childIndex = nodeById[Number(childId)];

                if (childIndex === undefined) {
                    throw new Error(`Bad child id #${childId} for node #${node.id}`);
                }

                if (prevChildIndex !== -1) {
                    nodeNextSibling[prevChildIndex] = childIndex + 1;
                }

                nodeParent[childIndex] = i + 1;
                prevChildIndex = childIndex;
            }
        }
    }

    return {
        callFrames,
        nodeById,
        nodeCallFrame,
        nodeParent,
        nodeNext,
        nodeNextSibling
    };
}
