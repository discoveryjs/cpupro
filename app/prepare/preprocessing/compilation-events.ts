import type { Dictionary } from '../dictionary.js';
import type { UniformCompilationRecord, UniformTraceEvent } from '../formats/types.js';
import type { CpuProCompilationRecord, CpuProScript, IProfileScriptsMap } from '../types.js';

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
    let previousId: number | null = null;
    let script: CpuProScript | null = null;

    for (const record of records) {
        if (record.scriptId !== previousId) {
            previousId = record.scriptId;
            script = previousId !== null && previousId > 0 ? scripts.get(previousId) ?? null : null;
        }

        record.callFrame = script !== null && record.start !== null && record.start >= 0
            ? dictionary.resolveLocation(null, script, record.start).callFrame
            : null;
    }
}
