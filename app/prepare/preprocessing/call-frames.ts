import type { Dictionary } from '../dictionary.js';
import type { GeneratedNodes, IProfileScriptsMap, V8CpuProfileCallFrame, V8CpuProfileNode } from '../types.js';
import { ProfileScriptsMap } from './scripts.js';
import { mapNodes as extractCallFramesFromNodes } from './nodes.js';

export function extractCallFrames(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames?: V8CpuProfileCallFrame[] | null,
    scriptsMap: IProfileScriptsMap = new ProfileScriptsMap(dict),
    gcNodes?: GeneratedNodes | null
) {
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
        callFrameByIndex,
        callFrameByNodeIndex
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
