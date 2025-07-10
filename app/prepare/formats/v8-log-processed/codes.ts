import type { V8CpuProfileCallFrameCodes, V8CallFrameCodeType } from '../../types.js';
import type { CodePositionTable, V8LogCode, V8LogProfile } from './types.js';
import { processCodeIcArray } from './ic.js';

export function functionTier(kind: V8LogCode['kind']): V8CallFrameCodeType {
    switch (kind) {
        case 'Ignition':
        case 'Unopt':
            return 'Ignition';

        case 'Baseline':
        case 'Sparkplug':
            return 'Sparkplug';

        case 'Maglev':
            return 'Maglev';

        case 'Builtin':
        case 'Opt':
        case 'Turbofan':
            return 'Turbofan';

        // removed from V8 in 2022: https://issues.chromium.org/issues/42202499
        case 'Turboprop':
            return 'Turboprop';

        default:
            return 'Unknown';
    }
}

export function processCodes(
    v8logCodes: V8LogProfile['code'],
    callFrameIndexByCode: Uint32Array,
    positionTableByCode: (CodePositionTable | null)[]
): V8CpuProfileCallFrameCodes[] {
    const callFrameCodesMap = new Map<number, V8CpuProfileCallFrameCodes>();

    for (let i = 0; i < v8logCodes.length; i++) {
        const callFrameIndex = callFrameIndexByCode[i];
        const code = v8logCodes[i];

        // ignore code when no call frame associated with the code
        if (callFrameIndex === 0) {
            continue;
        }

        // ignore all non JS codes
        if (typeof code.func !== 'number') {
            continue;
        }

        const positionTable = positionTableByCode[i];
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
            fns: positionTable?.fns || [],
            deopt: code.deopt,
            ic: processCodeIcArray(code, positionTable)
        });
    }

    return [...callFrameCodesMap.values()];
}
