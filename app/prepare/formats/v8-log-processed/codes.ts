import type { V8CpuProfileFunctionCodes, V8FunctionCodeType } from '../../types.js';
import type { V8LogCode, V8LogProfile } from './types.js';

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
    codes: V8LogProfile['code']
): V8CpuProfileFunctionCodes[] {
    const processedCodes: V8CpuProfileFunctionCodes[] = [];

    return functions.map((fn, index) => ({
        function: index,
        codes: fn.codes.map(codeIndex => {
            const code = codes[codeIndex];
            const codeSource = code.source || null;

            return {
                tm: code.tm || 0,
                tier: functionTier(code.kind),
                positions: codeSource?.positions || '',
                inlined: codeSource?.inlined || '',
                fns: codeSource?.fns || [],
                deopt: code.deopt
            };
        })
    }));

    return processedCodes;
}
