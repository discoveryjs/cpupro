import type { V8CpuProfileCallFrameCodes, V8CallFrameCodeType } from '../../types.js';
import type { CodePositions, V8LogCode, V8LogProfile } from './types.js';
import { processCodeIcArray } from './ic.js';

export function functionTier(kind: V8LogCode['kind']): V8CallFrameCodeType {
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
    codes: V8LogProfile['code'],
    callFrameIndexByCode: Uint32Array,
    positionsByCode: (CodePositions | null)[],
    callFrameIndexByFunction: Uint32Array | null = null
): V8CpuProfileCallFrameCodes[] {
    const callFrameCodesMap = new Map<number, V8CpuProfileCallFrameCodes>();
    const getCallFrameIndexByFunction = callFrameIndexByFunction !== null
        ? (func: number) => callFrameIndexByFunction[func]
        : (func: number) => func;

    for (let i = 0; i < codes.length; i++) {
        const callFrameIndex = callFrameIndexByCode[i];

        if (callFrameIndex !== 0) {
            const code = codes[i];
            const codeSource = code.source || null;
            let callFrameCodes = callFrameCodesMap.get(callFrameIndex);

            if (callFrameCodes === undefined) {
                callFrameCodesMap.set(callFrameIndex, callFrameCodes = {
                    callFrame: callFrameIndex,
                    codes: []
                });
            }

            callFrameCodes.codes.push({
                tm: code.tm || 0,
                tier: functionTier(code.kind),
                size: code.size || 0,
                positions: codeSource?.positions || '',
                inlined: codeSource?.inlined || '',
                fns: codeSource?.fns?.map(getCallFrameIndexByFunction) || [],
                deopt: code.deopt,
                ic: processCodeIcArray(code, positionsByCode[i])
            });
        }
    }

    return [...callFrameCodesMap.values()];
}
