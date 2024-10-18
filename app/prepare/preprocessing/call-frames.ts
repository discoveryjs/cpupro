import type { Dictionary } from '../dictionary.js';
import type { ReparentGcNodesResult } from './gc-samples.js';
import type {
    IProfileScriptsMap,
    V8CpuProfileCallFrame,
    V8CpuProfileExecutionContext,
    V8CpuProfileFunction,
    V8CpuProfileNode,
    V8CpuProfileScript
} from '../types.js';
import { createProfileScriptsMap } from './scripts.js';
import { mapFunctions as extractCallFramesFromFunctions } from './functions.js';
import { mapNodes as extractCallFramesFromNodes } from './nodes.js';

export function extractCallFrames(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    gcNodes?: ReparentGcNodesResult | null,
    callFrames?: V8CpuProfileCallFrame[] | null,
    scripts?: V8CpuProfileScript[] | null,
    functions?: V8CpuProfileFunction[] | null,
    executionContexts?: V8CpuProfileExecutionContext[] | null
) {
    // execution context goes first sice it affects package name
    // FIXME: next profiles could affect previously loaded profiles
    for (const { origin, name } of executionContexts || []) {
        dict.setPackageNameForOrigin(new URL(origin).host, name);
    }

    // scripts: scriptId -> script mapper
    const scriptMapper = createProfileScriptsMap(dict, scripts);

    // functions should be processed first, since they contain start/end offsets
    const callFrameByFunctionIndex = extractCallFramesFromFunctions(dict, scriptMapper, functions);

    // callFrames
    const callFrameByIndex = processInputCallFrames(dict, scriptMapper, callFrames);

    // nodes
    const callFrameByNodeIndex = extractCallFramesFromNodes(
        dict,
        nodes,
        callFrameByIndex,
        scriptMapper,
        gcNodes
    );

    return {
        callFrameByNodeIndex,
        callFrameByFunctionIndex
    };
}

export function processInputCallFrames(
    dict: Dictionary,
    mapper: IProfileScriptsMap,
    callFrames?: V8CpuProfileCallFrame[] | null
) {
    const map = new Uint32Array(callFrames?.length || 0);

    if (Array.isArray(callFrames)) {
        for (let i = 0; i < callFrames.length; i++) {
            map[i] = dict.resolveCallFrameIndex(callFrames[i], mapper);
        }

        // FIXME: callFrames from v8 log shouldn't dedup
        if (map.length !== callFrames.length) {
            console.warn('Merged call frames:', callFrames.length - map.length);
        }
    }

    return map;
}
