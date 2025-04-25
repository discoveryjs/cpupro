import type { CpuProCallFrame, CpuProFunctionCode, CpuProFunctionCodes, CpuProScript, V8CpuProfileFunctionCodes, V8FunctionCodeType } from '../types.js';
import { vmFunctionStateTierHotness, vmFunctionStateTiers } from '../const.js';

export function processFunctionCodes(
    functionCodes: V8CpuProfileFunctionCodes[] = [],
    callFrameByFunctionIndex: Uint32Array,
    callFrames: CpuProCallFrame[],
    startTime: number = 0
) {
    const allCodes: CpuProFunctionCode[] = [];
    const codesByScript = new Map<CpuProScript, {
        script: CpuProScript,
        compilation: CpuProFunctionCodes | null,
        callFrameCodes: CpuProFunctionCodes[]
    }>();
    const codesByCallFrame = Array.from(functionCodes, ({ function: functionIndex, codes }): CpuProFunctionCodes => ({
        callFrame: callFrames[callFrameByFunctionIndex[functionIndex]],
        topTier: 'Unknown',
        hotness: 'cold',
        codes: new Array(codes.length)
    }));

    for (let i = 0; i < codesByCallFrame.length; i++) {
        const callFrameCodes = codesByCallFrame[i];
        const { callFrame } = callFrameCodes;
        const { codes } = functionCodes[i];
        let topTier: V8FunctionCodeType = 'Unknown';

        // attach codes to a script
        // if (fn.script !== null) {
        //     if (fn.start === 0 && fn.end === script.source.length) {
        //         script.compilation = fn;
        //     } else {
        //         script.callFrames.push(fn);
        //     }
        // }

        // group by a script, attach codes to a script
        const script = callFrame.script;

        if (script !== null) {
            let scriptCodes = codesByScript.get(script);

            if (scriptCodes === undefined) {
                codesByScript.set(script, scriptCodes = {
                    script,
                    compilation: null,
                    callFrameCodes: []
                });
            }

            if (callFrame.start === 0 && callFrame.end === script.source?.length) {
                scriptCodes.compilation = callFrameCodes;
            } else {
                scriptCodes.callFrameCodes.push(callFrameCodes);
            }
        } else {
            // scriptFunction callFrames always has a script, if not that's probably an error
            console.warn('Script function has no script', callFrameCodes);
        }

        // process function's states
        for (let i = 0, topTierWeight = 0; i < codes.length; i++) {
            const state = codes[i];
            const tier = state.tier;
            const tierWeight = vmFunctionStateTiers.indexOf(tier);
            const code: CpuProFunctionCode = {
                ...state,
                tm: state.tm - startTime,
                fns: state.fns.map(idx => codesByCallFrame[idx].callFrame),
                duration: i !== codes.length - 1
                    ? codes[i + 1].tm - state.tm
                    : 0,
                callFrameCodes,
                callFrame
            };

            callFrameCodes.codes[i] = code;
            allCodes.push(code);

            if (tierWeight > topTierWeight) {
                topTierWeight = tierWeight;
                topTier = tier;
            }
        }

        callFrameCodes.topTier = topTier;
        callFrameCodes.hotness = vmFunctionStateTierHotness[topTier];
    }

    allCodes.sort((a, b) => a.tm - b.tm);

    return {
        codes: allCodes,
        codesByCallFrame,
        codesByScript: [...codesByScript.values()]
    };

    // process script function states
    // for (const fn of scriptFunctions) {
    //     for (let i = 0; i < fn.states.length; i++) {
    //         const state = fn.states[i];

    //         if (state.fns?.length > 0) {
    //             for (let j = 0; j < state.fns.length; j++) {
    //                 const inlineFnId = state.fns[j];
    //                 const inlinedFn = functionById.get(inlineFnId);

    //                 state.fns[j] = inlinedFn;

    //                 if (!inlinedFn) {
    //                     console.error('Inlined function is not resolved, function:', fn, `, state (#${i}):`, state, `, reference (#${j}):`, inlineFnId);
    //                 } else if (!inlinedFn.inlinedInto) {
    //                     inlinedFn.inlinedInto = [fn];
    //                 } else if (!inlinedFn.inlinedInto.includes(fn)) {
    //                     inlinedFn.inlinedInto.push(fn);
    //                 }
    //             }
    //         }
    //     }
    // }
}
