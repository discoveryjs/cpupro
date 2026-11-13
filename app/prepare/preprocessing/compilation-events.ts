import type { Dictionary } from '../dictionary.js';
import type { UniformCompilationRecord, UniformTraceEvent } from '../formats/types.js';
import type { CpuProCompilationRecord, CpuProCompilationSubject, CpuProScript, IProfileScriptsMap } from '../types.js';
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

// Compilation records of a thread in the model, copied from the unified records which the extraction of a format gives
// and the model neither keeps nor changes; a record takes its source event when the format has events. The records are
// ordered by their allocation intervals, outer ones first; they come in the order of their events and are sorted only
// when an interval is out of that order
// PERF: The fields of a record are listed rather than spread from the extracted record, which takes about half the
// time for the hundreds of thousands of compilations of a trace
export function createCompilationRecords(
    extracted: UniformCompilationRecord[],
    events: UniformTraceEvent[]
): CpuProCompilationRecord[] {
    const records: CpuProCompilationRecord[] = new Array(extracted.length);
    let previous: CpuProCompilationRecord | null = null;
    let ordered = true;

    for (let i = 0; i < extracted.length; i++) {
        const source = extracted[i];
        const record: CpuProCompilationRecord = {
            name: source.name,
            tm: source.tm,
            duration: source.duration,
            scriptId: source.scriptId,
            start: source.start,
            end: source.end,
            line: source.line,
            column: source.column,
            functionName: source.functionName,
            allocationStart: source.allocationStart,
            allocationEnd: source.allocationEnd,
            eventIndex: source.eventIndex,
            event: source.eventIndex !== null ? events[source.eventIndex] ?? null : null,
            callFrame: null,
            subject: null
        };

        records[i] = record;

        if (
            record.allocationStart === null ||
            record.allocationEnd === null ||
            record.allocationEnd <= record.allocationStart
        ) {
            continue;
        }

        if (previous !== null && compareCompilationRecords(previous, record) > 0) {
            ordered = false;
        }

        previous = record;
    }

    if (!ordered) {
        records.sort(compareCompilationRecords);
    }

    return records;
}

function compareCompilationRecords(first: CpuProCompilationRecord, second: CpuProCompilationRecord) {
    return (first.allocationStart ?? Infinity) - (second.allocationStart ?? Infinity) ||
        (second.allocationEnd ?? -Infinity) - (first.allocationEnd ?? -Infinity) ||
        (first.tm ?? 0) - (second.tm ?? 0) || (second.duration ?? 0) - (first.duration ?? 0);
}

// Call frames of compilation subjects. The records of a subject compile the same range, which gives the call frame
// with the source of the script; at the script start a stage of the script, if any, tells it is the script compiled.
// Without the source, the position of a record gives the frame, so the subject takes the frame of its first record
// that resolves
export function resolveCompilationCallFrames(
    subjects: CpuProCompilationSubject[],
    dictionary: Dictionary,
    scripts: IProfileScriptsMap
) {
    for (let i = 0; i < subjects.length; i++) {
        const subject = subjects[i];
        const { scriptId, records } = subject;
        const first = records[0];
        const script = scriptId !== null && scriptId > 0
            ? scripts.get(scriptId) ?? null
            : null;

        subject.callFrame = null;

        if (script === null || !hasCompilationSourceRange(first)) {
            continue;
        }

        if (script.source !== null) {
            const record = scriptStageOf(subject) ?? first;

            if (hasCompilationSourceRange(record)) {
                subject.callFrame = resolveCompilationCallFrame(record, script, dictionary, scripts);
            }

            continue;
        }

        for (let j = 0; j < records.length && subject.callFrame === null; j++) {
            const record = records[j];

            if (hasCompilationSourceRange(record)) {
                subject.callFrame = resolveCompilationCallFrame(record, script, dictionary, scripts);
            }
        }
    }

    // Records take the call frame of their subject, so the records of a thread give their call frames as they are
    for (let i = 0; i < subjects.length; i++) {
        const { callFrame, records } = subjects[i];

        for (let j = 0; j < records.length; j++) {
            records[j].callFrame = callFrame;
        }
    }
}

// A record of a stage of the script compilation, among the records of a subject at the script start
function scriptStageOf(subject: CpuProCompilationSubject) {
    if (subject.start !== 0) {
        return null;
    }

    for (let i = 0; i < subject.records.length; i++) {
        if (isScriptCompilationRecord(subject.records[i])) {
            return subject.records[i];
        }
    }

    return null;
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
