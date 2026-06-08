import type { CpuProCallFrame, CpuProLocation, CpuProScript, IProfileScriptsMap } from '../types.js';
import type { Dictionary } from '../dictionary.js';
import { createTreeSourceFromParent } from '../computations/build-trees.js';
import { CallTree } from '../computations/call-tree.js';
import { DictDimension, DictionaryMetrics, SamplesMetrics, SamplesMetricsFiltered } from '../computations/metrics.js';
import { scriptFromScriptId } from './scripts.js';

function positionRef(callFrameIndex: number, scriptOffset: number) {
    return (scriptOffset + 1) * 0x0100_0000 + callFrameIndex;
}

function positionNodeRef(nodeIndex: number, scriptOffset: number) {
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
export function processLocations(
    dictionary: Dictionary,
    nodeIndexById: Int32Array,
    nodeParent: Uint32Array,
    nodePositions: Int32Array,
    callFrames: CpuProCallFrame[],
    callFrameByNodeIndex: Uint32Array,
    samples: Uint32Array,
    sampleLocations: Int32Array | null
) {
    if (sampleLocations === null) {
        return { locationsTreeSource: null };
    }

    const positionsMap = new Map<number, number>();
    const positionNodeMap = new Map<number, number>();
    const positions: CpuProLocation[] = [];
    const nodesPosition = new Uint32Array(nodeParent.length);
    const samplesPositionNodes: number[] = [];
    const samplesPositionParent: number[] = [];

    // -> nodes
    for (let i = 0; i < nodePositions.length; i++) {
        const callFrameIndex = callFrameByNodeIndex[nodeParent[i]];
        const callFrame = callFrames[callFrameIndex];
        const scriptOffset = nodePositions[i];
        const ref = positionRef(callFrameIndex, scriptOffset);
        let positionIndex = positionsMap.get(ref);

        if (positionIndex === undefined) {
            const globalLocationIndex = dictionary.resolveLocationIndex(
                callFrame,
                callFrame.script,
                scriptOffset
            );

            positionsMap.set(ref, positionIndex = positions.push(dictionary.locations[globalLocationIndex]) - 1);
        }

        nodesPosition[i] = positionIndex;
    }

    // sampleLocations -> callFramePositions + nodes
    if (sampleLocations !== null) {
        for (let i = 0; i < samples.length; i++) {
            const nodeIndex = nodeIndexById[samples[i]];
            const callFrameIndex = callFrameByNodeIndex[nodeIndex] || 0;
            const callFrame = callFrames[callFrameIndex];
            const scriptOffset = sampleLocations[i];
            const ref = positionRef(callFrameIndex, scriptOffset);
            let positionIndex = positionsMap.get(ref);

            if (positionIndex === undefined) {
                const globalLocationIndex = dictionary.resolveLocationIndex(
                    callFrame,
                    callFrame.script,
                    scriptOffset
                );

                positionsMap.set(ref, positionIndex = positions.push(dictionary.locations[globalLocationIndex]) - 1);
            }

            const nodeRef = positionNodeRef(nodeIndex, scriptOffset);
            let sampleNodeId = positionNodeMap.get(nodeRef);

            if (sampleNodeId === undefined) {
                sampleNodeId = nodesPosition.length + positionNodeMap.size;
                positionNodeMap.set(nodeRef, sampleNodeId); // -> sourceIdToNode
                samplesPositionNodes.push(positionIndex); // -> nodes
                samplesPositionParent.push(nodeIndex); // -> parent & sourceIdToNode
            }

            samples[i] = sampleNodeId - nodesPosition.length;
        }
    }

    const positionArraysLength = nodesPosition.length + samplesPositionNodes.length;
    const positionNodes = new Uint32Array(positionArraysLength);
    const positionParent = new Uint32Array(positionArraysLength);

    positionNodes.set(nodesPosition);
    positionNodes.set(samplesPositionNodes, nodesPosition.length);
    positionParent.set(nodeParent);
    positionParent.set(samplesPositionParent, nodesPosition.length);

    const sourceIdToNode = new Int32Array(positionNodeMap.values());
    const locationsTreeSource = createTreeSourceFromParent(
        positionParent,
        sourceIdToNode,
        positionNodes,
        positions
    );

    return {
        locationsTreeSource
    };
}

type RawScriptIds = ArrayLike<number | string>;
type NumericVector = ArrayLike<number>;

function recomputeLocationDictionaryMetrics(
    locationIds: Uint32Array,
    values: Uint32Array,
    samplesCount: Uint32Array,
    selfValues: Uint32Array,
    totalValues: Uint32Array
) {
    samplesCount.fill(0);
    selfValues.fill(0);
    totalValues.fill(0);

    for (let i = 0; i < locationIds.length; i++) {
        const locationIndex = locationIds[i];
        const value = values[i];

        samplesCount[locationIndex]++;
        selfValues[locationIndex] += value;
        totalValues[locationIndex] += value;
    }
}

function callFramesMapFromDict(dict: Record<number, string>): (CpuProCallFrame | null)[] {
    const maxId = Object.keys(dict).reduce((max, key) => Math.max(max, Number(key)), 0);
    return Array.from({ length: maxId + 1 }, () => null);
}

function buildContextDicts(
    dictionary: Dictionary,
    builtinsNames: Record<number, string>,
    vmStateNames: Record<number, string>
) {
    const vmStateCallFrames = callFramesMapFromDict(vmStateNames);
    const builtinsCallFrames = callFramesMapFromDict(builtinsNames);

    for (const [code, name] of Object.entries(vmStateNames)) {
        vmStateCallFrames[code] = dictionary.resolveCallFrame({
            functionName: `(${name})`,
            scriptId: 0,
            url: null,
            lineNumber: -1,
            columnNumber: -1
        }, null as unknown as IProfileScriptsMap);
    }

    for (const [code, name] of Object.entries(builtinsNames)) {
        builtinsCallFrames[code] = dictionary.resolveCallFrame({
            functionName: `(builtin) ${name}`,
            scriptId: 0,
            url: null,
            lineNumber: -1,
            columnNumber: -1
        }, null as unknown as IProfileScriptsMap);
    }

    return {
        vmStateCallFrames,
        builtinsCallFrames
    };
}

const emptyDict = Object.freeze({});
export function createVectorLocations(
    dictionary: Dictionary,
    scriptsMap: IProfileScriptsMap,
    scriptIds: RawScriptIds | null,
    scriptOffsets: NumericVector | null,
    contextInfo: NumericVector | null,
    builtinsNames: Record<number, string> | null,
    vmStateNames: Record<number, string> | null,
    samplesMetrics: SamplesMetrics,
    samplesMetricsFiltered: SamplesMetricsFiltered
): DictDimension<CpuProLocation> & {
    sampleToLocation: Uint32Array;
} | null {
    if (scriptIds === null || scriptOffsets === null || scriptIds.length !== scriptOffsets.length) {
        return null;
    }

    const { vmStateCallFrames, builtinsCallFrames } = buildContextDicts(
        dictionary,
        builtinsNames ?? emptyDict,
        vmStateNames ?? emptyDict
    );

    const sampleToLocation = new Uint32Array(scriptOffsets.length);
    let prevCallFrame: CpuProCallFrame | null = null;
    let prevScriptId = scriptOffsets.length > 0 ? scriptIds[0] : 0;
    let prevScript: CpuProScript | null = scriptFromScriptId(prevScriptId, null, scriptsMap);
    let prevScriptOffset = scriptOffsets.length > 0 ? scriptOffsets[0] : 0;
    let prevContextInfo = 0;
    let prevLocationIndex = -1;

    for (let i = 0; i < scriptOffsets.length; i++) {
        const contextInfoValue = contextInfo !== null ? contextInfo[i] : 0;
        const scriptId = contextInfoValue === 0 ? scriptIds[i] : 0;
        const scriptOffset = scriptId !== 0 ? scriptOffsets[i] : -1;
        let locationIndex = prevLocationIndex;

        if (contextInfoValue !== prevContextInfo) {
            prevCallFrame = null;
            prevContextInfo = contextInfoValue;
            locationIndex = -1; // context info changed, need to recompute location index

            if (contextInfoValue !== 0) {
                // debugger;
                prevScriptId = 0;
                prevScript = null;
                prevScriptOffset = -1;
                prevCallFrame = contextInfoValue <= 0x0f
                    ? vmStateCallFrames[contextInfoValue]
                    : builtinsCallFrames[contextInfoValue >> 4];
            }
        }

        if (scriptId !== prevScriptId) {
            prevScriptId = scriptId;
            prevScript = scriptFromScriptId(scriptId, null, scriptsMap);
            prevScriptOffset = scriptOffset;
            locationIndex = -1;
        } else if (scriptOffset !== prevScriptOffset) {
            prevScriptOffset = scriptOffset;
            locationIndex = -1;
        }

        if (locationIndex === -1) {
            locationIndex = dictionary.resolveLocationIndex(
                prevCallFrame,
                prevScript,
                scriptOffset
            );
        }

        sampleToLocation[i] = locationIndex;
        prevLocationIndex = locationIndex;
    }

    const locationDictionary = dictionary.locations.slice();
    const samplesCountAll = new Uint32Array(locationDictionary.length);
    const selfValuesAll = new Uint32Array(locationDictionary.length);
    const totalValuesAll = new Uint32Array(locationDictionary.length);
    const samplesCountFiltered = new Uint32Array(locationDictionary.length);
    const selfValuesFiltered = new Uint32Array(locationDictionary.length);
    const totalValuesFiltered = new Uint32Array(locationDictionary.length);

    recomputeLocationDictionaryMetrics(sampleToLocation, samplesMetrics.values, samplesCountAll, selfValuesAll, totalValuesAll);
    recomputeLocationDictionaryMetrics(sampleToLocation, samplesMetricsFiltered.values, samplesCountFiltered, selfValuesFiltered, totalValuesFiltered);

    const all = new DictionaryMetrics(locationDictionary, samplesCountAll, selfValuesAll, totalValuesAll);
    const filtered = new DictionaryMetrics(locationDictionary, samplesCountFiltered, selfValuesFiltered, totalValuesFiltered);

    samplesMetricsFiltered.subscribe(() => {
        recomputeLocationDictionaryMetrics(sampleToLocation, samplesMetricsFiltered.values, samplesCountFiltered, selfValuesFiltered, totalValuesFiltered);
        filtered.sync();
        filtered.notify();
    });

    return {
        sampleToLocation,
        all,
        filtered
    };
}
