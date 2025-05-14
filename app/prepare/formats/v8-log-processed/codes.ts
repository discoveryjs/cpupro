import type { V8CpuProfileFunctionCodes, V8CpuProfileICEntry, V8FunctionCodeType } from '../../types.js';
import { FEATURE_INLINE_CACHE } from '../../const.js';
import { findPositionsCodeIndex } from './positions.js';
import type { CodePositions, NumericArray, V8LogCode, V8LogProfile } from './types.js';

export function functionTier(kind: V8LogCode['kind']): V8FunctionCodeType {
    switch (kind) {
        case 'Builtin':
        case 'Ignition':
        case 'Unopt':
            return 'Ignition';

        case 'Baseline':
        case 'Sparkplug':
            return 'Sparkplug';

        case 'Maglev':
            return 'Maglev';

        // removed from V8 in 2022: https://issues.chromium.org/issues/42202499
        case 'Turboprop':
            return 'Turboprop';

        case 'Opt':
        case 'Turbofan':
            return 'Turbofan';

        default:
            return 'Unknown';
    }
}

export function processFunctionCodes(
    functions: V8LogProfile['functions'],
    codes: V8LogProfile['code'],
    functionsIndexMap: NumericArray | null = null,
    positionsByCode: (CodePositions | null)[]
): V8CpuProfileFunctionCodes[] {
    const processedCodes: V8CpuProfileFunctionCodes[] = Array.from(new Set(functionsIndexMap), (_, index) => ({
        function: index,
        codes: []
    }));
    const getFunctionIndex = functionsIndexMap !== null
        ? (func: number) => functionsIndexMap[func]
        : (func: number) => func;

    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const func = code.func;

        if (typeof func === 'number') {
            const codeSource = code.source || null;
            const codePositions = positionsByCode[i];

            processedCodes[getFunctionIndex(func)].codes.push({
                tm: code.tm || 0,
                tier: functionTier(code.kind),
                size: code.size || 0,
                positions: codeSource?.positions || '',
                inlined: codeSource?.inlined || '',
                fns: codeSource?.fns?.map(getFunctionIndex) || [],
                deopt: code.deopt,
                ic: FEATURE_INLINE_CACHE && Array.isArray(code.ic)
                    ? code.ic.map((entry): V8CpuProfileICEntry => {
                        const offset = entry.offset;
                        let scriptOffset = codeSource?.start ?? -1;
                        let inliningId = -1;

                        if (codePositions !== null) {
                            const codePositionsIndex = findPositionsCodeIndex(
                                codePositions.positions,
                                // Machine code functions on the stack
                                // that are not currently executing store pc
                                // on the next instruction after the callee is called,
                                // so subtract one from the position
                                offset - (i > 0 && codePositions.pcOnNextInstruction ? 1 : 0)
                            );

                            inliningId = codePositions.positions[codePositionsIndex + 2];
                            scriptOffset = codePositions.positions[codePositionsIndex + 1];
                        }

                        return {
                            tm: entry.tm,
                            type: entry.type,
                            inliningId,
                            scriptOffset,
                            oldState: entry.oldState,
                            newState: entry.newState,
                            map: entry.map,
                            key: entry.key,
                            modifier: entry.modifier,
                            slowReason: entry.slowReason
                        };
                    })
                    : undefined
            });
        }
    }

    return processedCodes;
}
