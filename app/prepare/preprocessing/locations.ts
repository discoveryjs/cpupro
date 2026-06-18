import type { CpuProCallFrame, CpuProScript, IProfileScriptsMap } from '../types.js';
import type { Dictionary } from '../dictionary.js';
import { CallTree } from '../computations/call-tree.js';
import { scriptFromScriptId } from './scripts.js';
import { GeneratedNodes } from './nodes.js';

function locationRef(callFrameIndex: number, scriptOffset: number) {
    return (scriptOffset + 1) * 0x0100_0000 + callFrameIndex;
}

function locationNodeRef(nodeIndex: number, scriptOffset: number) {
    return (scriptOffset + 1) * 0x0100_0000 + nodeIndex;
}

/**
 * Ensure sampleLocations exist by deriving from call frame definitions if not provided.
 *
 * Profiles can provide sample locations in three ways:
 * 1. Precise execution points (scriptOffset) - use directly
 * 2. No location data - derive from call frame definitions (this function)
 * 3. Mixed - some samples have locations, others don't
 *
 * When deriving from call frames, we use the function definition location:
 *   - scriptOffset comes from callFrame.start (or -1 if not available)
 *   - line/column will come from callFrame.line/column (in processLocations)
 *
 * Returns Int32Array of script offsets, or null if no data available.
 */
export function ensureLocations(
    samples: Uint32Array,
    sampleLocations: Int32Array | null,
    sampleToNode: Uint32Array,
    callFramesTree: CallTree<CpuProCallFrame> | null
): Int32Array | null {
    // If we already have sample locations (precise execution points), use them
    if (sampleLocations !== null) {
        return sampleLocations;
    }

    // No explicit locations provided - derive from call frame definitions
    if (callFramesTree === null) {
        return null; // No data to derive from
    }

    // Build location offsets from call frame definitions
    const locations = new Int32Array(samples.length);
    const { nodes, dictionary } = callFramesTree;

    for (let i = 0; i < samples.length; i++) {
        const sampleId = samples[i];
        const nodeIdx = sampleToNode[sampleId];
        const callFrameIdx = nodes[nodeIdx];
        const callFrame = dictionary[callFrameIdx];

        // Use call frame's definition scriptOffset (start), or -1 if not available
        // processLocations will create full location objects with line/column from callFrame
        locations[i] = callFrame.start !== -1 ? callFrame.start : -1;
    }

    return locations;
}

/**
 * Process sample locations to build a location tree.
 *
 * Locations represent execution points that can be:
 * - Precise execution locations within functions (from profile data)
 * - Call frame definition locations (derived via ensureLocations)
 *
 * Each location combines:
 * - callFrame: The function being executed
 * - scriptOffset: Byte offset in script (from profile or callFrame.start, or -1)
 * - line/column: Position in source (from callFrame, can compute from scriptOffset if source available)
 *
 * Returns a location tree for aggregating metrics by execution point.
 */
export function createLocationsFromScriptOffsets(
    dict: Dictionary,
    nodeParent: Uint32Array,
    nodeScriptOffsets: Int32Array,
    nodeCallFrames: Uint32Array,
    samples: Uint32Array,
    sampleScriptOffsets: Int32Array | null
) {
    if (sampleScriptOffsets === null) {
        return null;
    }

    const callFrames = dict.callFrames;
    const locationByRef = new Map<number, number>();
    const locationNodeMap = new Map<number, number>();
    const treeLocationNodes = new Uint32Array(nodeParent.length);
    const sampledLocationNodes: number[] = [];
    const sampledLocationParents: number[] = [];

    // Locations from nodes -> callFramePositions + nodes
    // -> nodes
    for (let i = 0; i < nodeScriptOffsets.length; i++) {
        const callFrameIndex = nodeCallFrames[nodeParent[i]];
        const scriptOffset = nodeScriptOffsets[i];
        const ref = locationRef(callFrameIndex, scriptOffset);
        let locationIndex = locationByRef.get(ref);

        if (locationIndex === undefined) {
            locationByRef.set(ref, locationIndex = dict.resolveLocationIndex(
                callFrames[callFrameIndex],
                null,
                scriptOffset
            ));
        }

        treeLocationNodes[i] = locationIndex;
    }

    // Locations from samples
    // sampleLocations -> callFramePositions + nodes
    if (sampleScriptOffsets !== null) {
        // nodes indecies created after samples
        const sampleNodeIndexBase = treeLocationNodes.length;

        for (let i = 0; i < samples.length; i++) {
            const nodeIndex = samples[i];
            const scriptOffset = sampleScriptOffsets[i];
            const nodeRef = locationNodeRef(nodeIndex, scriptOffset);
            let sampleNodeIndex = locationNodeMap.get(nodeRef);

            if (sampleNodeIndex === undefined) {
                const callFrameIndex = nodeCallFrames[nodeIndex] || 0;
                const ref = locationRef(callFrameIndex, scriptOffset);
                let locationIndex = locationByRef.get(ref);

                if (locationIndex === undefined) {
                    locationByRef.set(ref, locationIndex = dict.resolveLocationIndex(
                        callFrames[callFrameIndex],
                        null,
                        scriptOffset
                    ));
                }

                sampleNodeIndex = locationNodeMap.size + sampleNodeIndexBase;
                locationNodeMap.set(nodeRef, sampleNodeIndex); // -> sourceIdToNode
                sampledLocationNodes.push(locationIndex); // -> nodes
                sampledLocationParents.push(nodeIndex); // -> parent & sourceIdToNode
            }

            samples[i] = sampleNodeIndex - sampleNodeIndexBase;
        }
    }

    // concat arrays for tree source
    const locationArraysLength = treeLocationNodes.length + sampledLocationNodes.length;
    const nodes = new Uint32Array(locationArraysLength);
    const parent = new Uint32Array(locationArraysLength);
    const sourceIdToNode = new Int32Array(locationNodeMap.values());

    nodes.set(treeLocationNodes);
    nodes.set(sampledLocationNodes, treeLocationNodes.length);
    parent.set(nodeParent);
    parent.set(sampledLocationParents, nodeParent.length);

    return {
        nodes,
        parent,
        sourceIdToNode,
        dictionary: dict.locations
    };
}

type RawScriptIds = ArrayLike<number | string>;
type NumericVector = ArrayLike<number>;

function callFramesMapFromDict(dict: Record<number, string>): (CpuProCallFrame | null)[] {
    const maxId = Object.keys(dict).reduce((max, key) => Math.max(max, Number(key)), 0);
    return Array.from({ length: maxId + 1 }, () => null);
}

function buildContextVmStateDict(
    dictionary: Dictionary,
    vmStateNames: Record<number, string>
) {
    const vmStateCallFrames = callFramesMapFromDict(vmStateNames);

    for (const [code, name] of Object.entries(vmStateNames)) {
        vmStateCallFrames[code] = dictionary.resolveCallFrame({
            functionName: `(${name})`,
            scriptId: 0,
            url: null,
            lineNumber: -1,
            columnNumber: -1
        }, null as unknown as IProfileScriptsMap);
    }

    return vmStateCallFrames;
}

function buildContextBuiltinDict(
    dictionary: Dictionary,
    builtinsNames: Record<number, string>
) {
    const builtinsCallFrames = callFramesMapFromDict(builtinsNames);

    for (const [code, name] of Object.entries(builtinsNames)) {
        builtinsCallFrames[code] = dictionary.resolveCallFrame({
            functionName: `(builtin) ${name}`,
            scriptId: 0,
            url: null,
            lineNumber: -1,
            columnNumber: -1
        }, null as unknown as IProfileScriptsMap);
    }

    return builtinsCallFrames;
}

const emptyDict = Object.freeze({});
export function createVectorLocations(
    dictionary: Dictionary,
    scriptsMap: IProfileScriptsMap,
    scriptIds: RawScriptIds | null,
    scriptOffsets: NumericVector | null,
    contextInfo: NumericVector | null,
    builtinsNames: Record<number, string> | null,
    vmStateNames: Record<number, string> | null
): {
    generatedNodes: GeneratedNodes;
    samples: Uint32Array;
} | null {
    if (scriptIds === null || scriptOffsets === null || scriptIds.length !== scriptOffsets.length) {
        return null;
    }

    const vmStateCallFrames = buildContextVmStateDict(
        dictionary,
        vmStateNames ?? emptyDict
    );
    const builtinsCallFrames = buildContextBuiltinDict(
        dictionary,
        builtinsNames ?? emptyDict
    );

    const generatedNodes = new GeneratedNodes(dictionary, 0);
    const sampleToNode = new Uint32Array(scriptOffsets.length);
    const locationIndexToNodeIndex = new Array(dictionary.locations.length).fill(-1);
    // const sampleToLocation = new Uint32Array(scriptOffsets.length);
    // let prevCallFrame: CpuProCallFrame | null = null;
    let prevScriptId = scriptOffsets.length > 0 ? scriptIds[0] : 0;
    let prevScript: CpuProScript | null = scriptFromScriptId(prevScriptId, null, scriptsMap);
    let prevScriptOffset = scriptOffsets.length > 0 ? scriptOffsets[0] : 0;
    let prevContextInfoValue = contextInfo !== null && contextInfo.length > 0 ? contextInfo[0] : 0;
    // let prevContextInfo = 0;
    let prevLocationIndex = -1;
    let nodeIndex = 0;

    // root node (unknown call frame, self-parent, unknown location)
    locationIndexToNodeIndex[1] = generatedNodes.addNode(1, 0, 1);
    locationIndexToNodeIndex[0] = generatedNodes.addNode(0, 0, 0);

    for (let i = 0; i < scriptOffsets.length; i++) {
        const contextInfoValue = contextInfo !== null ? contextInfo[i] : 0;
        const scriptId = scriptIds[i];
        const scriptOffset = scriptOffsets[i];
        let locationIndex = prevLocationIndex;

        if (scriptId !== prevScriptId) {
            prevScriptId = scriptId;
            prevScript = scriptFromScriptId(scriptId, null, scriptsMap);
            prevScriptOffset = scriptOffset;
            prevContextInfoValue = contextInfoValue;
            locationIndex = -1;
        } else if (scriptOffset !== prevScriptOffset) {
            prevScriptOffset = scriptOffset;
            prevContextInfoValue = contextInfoValue;
            locationIndex = -1;
        } else if (contextInfoValue !== prevContextInfoValue) {
            prevContextInfoValue = contextInfoValue;
            locationIndex = -1;
        }

        if (locationIndex === -1) {
            locationIndex = scriptId !== 0
                ? dictionary.resolveLocationIndex(
                    null,
                    prevScript,
                    scriptOffset
                )
                : contextInfoValue !== 0
                    ? dictionary.resolveLocationIndex(
                        contextInfoValue <= 0x0f
                            ? vmStateCallFrames[contextInfoValue]
                            : builtinsCallFrames[contextInfoValue >> 4]
                    )
                    : 0; // unknown location

            if (locationIndex >= locationIndexToNodeIndex.length) {
                locationIndexToNodeIndex.push(-1);
                nodeIndex = -1;
            } else {
                nodeIndex = locationIndexToNodeIndex[locationIndex];
            }

            if (nodeIndex === -1) {
                nodeIndex = generatedNodes.addNode(
                    dictionary.locations[locationIndex].callFrame.id - 1,
                    0,
                    locationIndex
                );
                locationIndexToNodeIndex[locationIndex] = nodeIndex;
            }
        }

        sampleToNode[i] = nodeIndex;
        // sampleToLocation[i] = locationIndex;
        prevLocationIndex = locationIndex;
    }

    // second pass to attach context info to js frames
    if (contextInfo !== null) {
        const nodesCount = generatedNodes.count;
        const contextNodesMap = new Map<number, number>();

        for (let i = 0; i < contextInfo.length; i++) {
            const contextInfoValue = contextInfo[i];

            if (contextInfoValue !== 0 && scriptIds[i] !== 0) {
                const ref = nodesCount * contextInfoValue + sampleToNode[i];
                const callFrame = contextInfoValue <= 0x0f
                    ? vmStateCallFrames[contextInfoValue]
                    : builtinsCallFrames[contextInfoValue >> 4];
                let contextNodeIndex = contextNodesMap.get(ref);

                if (contextNodeIndex === undefined) {
                    contextNodesMap.set(ref, contextNodeIndex = generatedNodes.addNode(
                        callFrame!.id - 1,
                        sampleToNode[i],
                        dictionary.resolveLocationIndex(
                            callFrame
                        )
                    ));
                }

                sampleToNode[i] = contextNodeIndex;
                // not needed
                // sampleToLocation[i] = dictionary.resolveLocationIndex(
                //     callFrame
                // );
            }
        }
    }

    return {
        generatedNodes,
        samples: sampleToNode
    };
}
