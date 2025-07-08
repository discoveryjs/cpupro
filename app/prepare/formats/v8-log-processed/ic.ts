import type { V8CpuProfileICEntry } from '../../types.js';
import type { CodePositions, V8LogCode } from './types.js';
import { FEATURE_INLINE_CACHE } from '../../const.js';
import { findPositionsCodeIndex } from './positions.js';

export function processCodeIcArray(
    code: V8LogCode,
    codePositions: CodePositions | null
): V8CpuProfileICEntry[] | undefined {
    if (!FEATURE_INLINE_CACHE || !Array.isArray(code.ic)) {
        return;
    }

    return code.ic.map(entry => {
        const offset = entry.offset;
        let scriptOffset = code.source?.start ?? -1;
        let inliningId = -1;

        if (codePositions !== null) {
            const codePositionsIndex = findPositionsCodeIndex(codePositions.positions, offset);

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
    });
}
