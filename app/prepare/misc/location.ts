import type { CpuProCallFrame, CpuProLocation, CpuProScript } from '../types.js';
import { getLineColumnFromScriptOffset, getPosFromScriptLineColumn } from './parse-source.js';

type LocationInput = {
    callFrame?: CpuProCallFrame;
    script?: CpuProScript | null;
    scriptOffset?: number;
    line?: number;
    column?: number;
};

function normalizeNumber(value: number | undefined) {
    return typeof value === 'number' && value >= 0 ? value : -1;
}

export function createLocation(input: LocationInput): CpuProLocation {
    const callFrame = input.callFrame;
    const script = callFrame?.script ?? input.script ?? null;

    let scriptOffset = normalizeNumber(input.scriptOffset);
    let line = normalizeNumber(input.line);
    let column = normalizeNumber(input.column);

    if (script === null) {
        return {
            callFrame,
            script: null,
            scriptOffset: -1,
            line: -1,
            column: -1
        };
    }

    if (scriptOffset === -1 && line !== -1 && column !== -1) {
        scriptOffset = getPosFromScriptLineColumn(script, line, column);
    }

    if (scriptOffset !== -1) {
        const lineColumn = getLineColumnFromScriptOffset(script, scriptOffset);

        if (lineColumn !== null) {
            line = lineColumn.line;
            column = lineColumn.column;
        }
    }

    return {
        callFrame,
        script,
        scriptOffset,
        line,
        column
    };
}
