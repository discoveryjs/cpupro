import type { Dictionary } from '../dictionary.js';
import type { ReparentGcNodesResult } from './gc-samples.js';
import type { IProfileScriptsMap, V8CpuProfileCallFrame, V8CpuProfileFunction, V8CpuProfileNode } from '../types.js';
import { ProfileScriptsMap } from './scripts.js';
import { mapFunctions as extractCallFramesFromFunctions } from './functions.js';
import { mapNodes as extractCallFramesFromNodes } from './nodes.js';

export function extractCallFrames(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames?: V8CpuProfileCallFrame[] | null,
    functions?: V8CpuProfileFunction[] | null,
    scriptsMap: IProfileScriptsMap = new ProfileScriptsMap(dict),
    gcNodes?: ReparentGcNodesResult | null
) {
    // functions should be processed first, since they contain start/end offsets
    const callFrameByFunctionIndex = extractCallFramesFromFunctions(dict, scriptsMap, functions);

    // callFrames
    const callFrameByIndex = processInputCallFrames(dict, scriptsMap, callFrames);

    // nodes
    const callFrameByNodeIndex = extractCallFramesFromNodes(
        dict,
        nodes,
        callFrameByIndex,
        scriptsMap,
        gcNodes
    );

    return {
        callFrameByNodeIndex,
        callFrameByFunctionIndex
    };
}

export function processInputCallFrames(
    dict: Dictionary,
    scriptsMap: IProfileScriptsMap,
    callFrames?: V8CpuProfileCallFrame[] | null
) {
    const map = new Uint32Array(callFrames?.length || 0);

    if (Array.isArray(callFrames)) {
        for (let i = 0; i < callFrames.length; i++) {
            map[i] = dict.resolveCallFrameIndex(callFrames[i], scriptsMap);
        }

        // FIXME: callFrames from v8 log shouldn't dedup
        if (map.length !== callFrames.length) {
            console.warn('Merged call frames:', callFrames.length - map.length);
        }
    }

    return map;
}
