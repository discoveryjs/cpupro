import type { CpuProCompilationRecord } from '../../app/prepare/types.js';
import { indexCompilationStages, prepareCompilationSubjects } from '../../app/prepare/preprocessing/script-compilation.js';

// A complete compilation record of script 7, without source position details, allocations or trace event provenance
export function createCompilationRecord(fields: Partial<CpuProCompilationRecord> = {}): CpuProCompilationRecord {
    return {
        name: 'Compile',
        tm: 0,
        duration: 1,
        scriptId: 7,
        start: 0,
        end: 0,
        line: null,
        column: null,
        functionName: null,
        allocationStart: null,
        allocationEnd: null,
        eventIndex: null,
        event: null,
        callFrame: null,
        subject: null,
        stage: 0,
        ...fields
    };
}

// Subjects and stages of compilation records, as a session prepares the records of a thread; returns the subjects
export function prepareCompilationRecords(records: CpuProCompilationRecord[]) {
    const subjects = prepareCompilationSubjects(records);

    indexCompilationStages(records);

    return subjects;
}
