import { mapCallFrames } from './preprocessing/call-frames.js';
import { mapScripts } from './preprocessing/scripts.js';
import type { Dictionary } from './dictionary.js';
import type {
    V8CpuProfileCallFrame,
    V8CpuProfileExecutionContext,
    V8CpuProfileFunction,
    V8CpuProfileFunctionCodes,
    V8CpuProfileNode,
    V8CpuProfileScript
} from './types.js';
import { mapNodes } from './preprocessing/nodes.js';
import { mapFunctions } from './preprocessing/functions.js';
import { processFunctionCodes } from './preprocessing/function-codes.js';

export function consumeInput(
    dict: Dictionary,
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[],
    callFrames?: V8CpuProfileCallFrame[] | null,
    scripts?: V8CpuProfileScript[] | null,
    functions?: V8CpuProfileFunction[] | null,
    functionCodes?: V8CpuProfileFunctionCodes[] | null,
    executionContexts?: V8CpuProfileExecutionContext[] | null
) {
    // execution context goes first sice it affects package name
    // FIXME: next profiles may affect previously loaded profiles
    for (const { origin, name } of executionContexts || []) {
        dict.setPackageNameForOrigin(new URL(origin).host, name);
    }

    // scripts
    const scriptMapper = mapScripts(dict, scripts);

    // functions
    const profileFunctions = mapFunctions(dict, scriptMapper, functions);
    const scriptFunctions = processFunctionCodes(functionCodes || [], profileFunctions);

    // callFrames
    const callFrameByIndex = mapCallFrames(dict, scriptMapper, callFrames);

    // nodes
    const { nodeIndexById, callFrameByNodeIndex } = mapNodes(dict, nodes, callFrameByIndex, scriptMapper);

    // console.log({ scripts: [...scriptMapper.entries()].sort((a, b) => a[0] - b[0]) });
    // const profile = {
    //     scripts: scriptMapper
    // };

    return {
        scriptFunctions,
        nodeIndexById,
        callFrameByNodeIndex
    };
}
