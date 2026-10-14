import type { Dictionary } from '../dictionary.js';
import type { UniformCompilationRecord, UniformTraceEvent } from '../formats/types.js';
import type { CpuProCompilationRecord, CpuProScript, IProfileScriptsMap } from '../types.js';
import {
    getFunctionAtScriptOffset,
    getScriptLineColumnFromOffset,
    matchCallFrameIdentity
} from '../misc/script-function-resolution.js';

type CompilationRecordWithRange = CpuProCompilationRecord & {
    scriptId: number;
    start: number;
    end: number;
};

export function prepareCompilationRecords(records: UniformCompilationRecord[], events: UniformTraceEvent[]): CpuProCompilationRecord[] {
    const compilations = records.map(record => ({
        ...record,
        event: record.eventIndex !== null ? events[record.eventIndex] ?? null : null
    }));
    let previous: CpuProCompilationRecord | null = null;

    for (const record of compilations) {
        if (record.allocationStart === null || record.allocationEnd === null || record.allocationEnd <= record.allocationStart) {
            continue;
        }

        if (previous !== null && compareCompilationRecords(previous, record) > 0) {
            compilations.sort(compareCompilationRecords);
            break;
        }

        previous = record;
    }

    return compilations;
}

function compareCompilationRecords(first: CpuProCompilationRecord, second: CpuProCompilationRecord) {
    return (first.allocationStart ?? Infinity) - (second.allocationStart ?? Infinity) ||
        (second.allocationEnd ?? -Infinity) - (first.allocationEnd ?? -Infinity) ||
        (first.tm ?? 0) - (second.tm ?? 0) || (second.duration ?? 0) - (first.duration ?? 0);
}

export function resolveCompilationCallFrames(records: CpuProCompilationRecord[], dictionary: Dictionary, scripts: IProfileScriptsMap) {
    const resolved = new Map<CpuProScript, Map<number, CpuProCompilationRecord>>();
    let previousId: number | null = null;
    let script: CpuProScript | null = null;

    for (const record of records) {
        if (record.scriptId !== previousId) {
            previousId = record.scriptId;
            script = previousId !== null && previousId > 0 ? scripts.get(previousId) ?? null : null;
        }

        if (script === null || !hasCompilationSourceRange(record)) {
            record.callFrame = null;
            continue;
        }

        if (script.source === null) {
            record.callFrame = resolveCompilationCallFrame(record, script, dictionary, scripts);
            continue;
        }

        let byStart = resolved.get(script);

        if (!byStart) {
            resolved.set(script, byStart = new Map());
        }

        const previous = byStart.get(record.start);

        if (previous && canReuseCompilationFrame(previous, record)) {
            record.callFrame = previous.callFrame;
        } else {
            record.callFrame = resolveCompilationCallFrame(record, script, dictionary, scripts);
            byStart.set(record.start, record);
        }
    }
}

export function isScriptCompilationRecord(record: CpuProCompilationRecord) {
    switch (record.name) {
        case 'ParseProgram':
        case 'CompileCode':
        case 'FinishOffThreadDeserialize':
        case 'FinalizeDeserialization':
            return true;
        default:
            return false;
    }
}

function hasCompilationSourceRange(record: CpuProCompilationRecord): record is CompilationRecordWithRange {
    const { scriptId, start, end } = record;

    if (scriptId === null || start === null || end === null) {
        return false;
    }

    return start >= 0 && end >= start;
}

function canReuseCompilationFrame(previous: CpuProCompilationRecord, record: CpuProCompilationRecord) {
    if (previous.end !== record.end || previous.functionName !== record.functionName) {
        return false;
    }

    if (record.start === 0) {
        return isScriptCompilationRecord(previous) === isScriptCompilationRecord(record);
    }

    return true;
}

function resolveCompilationCallFrame(
    record: CompilationRecordWithRange,
    script: CpuProScript,
    dictionary: Dictionary,
    scripts: IProfileScriptsMap
) {
    const { scriptId, start, end } = record;
    let position = getScriptLineColumnFromOffset(script, start);

    if (position === null) {
        position = start === 0
            ? { line: 0, column: 0 }
            : { line: record.line ?? -1, column: record.column ?? -1 };
    }

    const identity = { script, start, end, ...position };
    const range = getFunctionAtScriptOffset(script, start);
    const wholeScript = start === 0 && end === script.source?.length;
    const exactRange = range?.callFrameStart === start && range.end === end;

    if (wholeScript && (isScriptCompilationRecord(record) || !exactRange)) {
        return dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
    }

    const candidate = dictionary.resolveLocationCallFrame(script, start, position.line, position.column);

    if (matchCallFrameIdentity(candidate, identity)) {
        return candidate;
    }

    let functionName = record.functionName;

    if (!functionName && exactRange) {
        functionName = range.name;
    }

    const callFrame = dictionary.resolveCallFrame({
        scriptId,
        url: script.url,
        functionName: functionName || '(anonymous)',
        lineNumber: position.line,
        columnNumber: position.column,
        start,
        end
    }, scripts);

    return matchCallFrameIdentity(callFrame, identity) ? callFrame : null;
}
