import type { CpuProCallFrame, CpuProFunctionCodes, V8CpuProfileFunctionCodes, V8FunctionCodeType } from '../types.js';
import { vmFunctionStateTierHotness, vmFunctionStateTiers } from '../const.js';

export function processFunctionCodes(
    functionCodes: V8CpuProfileFunctionCodes[] = [],
    callFrameByFunctionIndex: Uint32Array,
    callFrames: CpuProCallFrame[],
    startTime: number = 0
): CpuProFunctionCodes[] {
    return functionCodes.map(({ function: functionIndex, codes }) => {
        let topTier: V8FunctionCodeType = 'Unknown';
        const callFrame = callFrames[callFrameByFunctionIndex[functionIndex]];
        const fnCodes: CpuProFunctionCodes = {
            callFrame,
            topTier,
            hotness: 'cold',
            codes: new Array(codes.length)
        };

        // attach codes to a script
        // if (fn.script !== null) {
        //     if (fn.start === 0 && fn.end === script.source.length) {
        //         script.compilation = fn;
        //     } else {
        //         script.callFrames.push(fn);
        //     }
        // }

        // process function's states
        for (let i = 0, topTierWeight = 0; i < codes.length; i++) {
            const state = codes[i];
            const tier = state.tier;
            const tierWeight = vmFunctionStateTiers.indexOf(tier);

            fnCodes.codes[i] = {
                ...state,
                tm: state.tm - startTime,
                duration: i !== codes.length - 1
                    ? codes[i + 1].tm - state.tm
                    : 0,
                callFrame
            };

            if (tierWeight > topTierWeight) {
                topTierWeight = tierWeight;
                topTier = tier;
            }
        }

        fnCodes.topTier = topTier;
        fnCodes.hotness = vmFunctionStateTierHotness[topTier];

        return fnCodes;
    });

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
