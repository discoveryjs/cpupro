import type { V8CpuProfileFunctionCodes, V8FunctionCodeType } from '../../types.js';
import type { NumericArray, V8LogCode, V8LogProfile } from './types.js';

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
    functionsIndexMap: NumericArray | null = null
): V8CpuProfileFunctionCodes[] {
    const processedCodes: V8CpuProfileFunctionCodes[] = Array.from(new Set(functionsIndexMap), (_, index) => ({
        function: index,
        codes: []
    }));

    for (const code of codes) {
        const func = code.func;

        if (typeof func === 'number') {
            const codeSource = code.source || null;
            const functionIndex = functionsIndexMap !== null
                ? functionsIndexMap[func]
                : func;

            processedCodes[functionIndex].codes.push({
                tm: code.tm || 0,
                tier: functionTier(code.kind),
                positions: codeSource?.positions || '',
                inlined: codeSource?.inlined || '',
                fns: codeSource?.fns || [],
                deopt: code.deopt
            });
        }
    }

    return processedCodes;
}
