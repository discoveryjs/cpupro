import type { Dictionary } from './dictionary.js';
import type { ReparentGcNodesResult } from './preprocessing/gc-samples.js';
import type {
    V8CpuProfileCallFrame,
    V8CpuProfileExecutionContext,
    V8CpuProfileFunction,
    V8CpuProfileNode,
    V8CpuProfileScript
} from './types.js';
import { mapScripts } from './preprocessing/scripts.js';
import { mapFunctions } from './preprocessing/functions.js';
import { mapCallFrames } from './preprocessing/call-frames.js';
import { mapNodes } from './preprocessing/nodes.js';

export function consumeCallFrames(
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
    const scriptMapper = mapScripts(dict, scripts);

    // functions
    const callFrameByFunctionIndex = mapFunctions(dict, scriptMapper, functions);

    // callFrames
    const callFrameByIndex = mapCallFrames(dict, scriptMapper, callFrames);

    // nodes
    const callFrameByNodeIndex = mapNodes(
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
