import { RuntimeCode, V8CpuProfile, V8CpuProfileScript } from '../types';

export type Ownership = {
    api: string;
    areas: string[];
    files: Record<string, number[]>;
}

export type UniformProfilingDataset = {
    sessions: UniformProfilingSession[];
}
export type UniformProfilingSession = {
    name: string | null;
    runtime: RuntimeCode | null;
    startTime: string | null;
    source: string | null;
    dataOrigin: string | null;

    setupId: string | number | null;
    buildId: string | number | null;
    scenarioId: string | number | null;

    processes: UniformProcess[];
    threads: UniformThread[];
    profiles: UniformProfile[];

    ownership: Ownership | null;
}
export type UniformProcess = {
    pid: number;
    name: string | null;
}
export type UniformThread = {
    pid: number;
    tid: number;
    name: string | null;
    isolate?: string | null;
    scripts: V8CpuProfileScript[];
    events: UniformTraceEvent[];
    userTimings: UniformTraceEvent[];
    compilations?: UniformCompilationRecord[];
}
export type UniformCompilationRecord = {
    name: string;
    tm: number | null;
    duration: number | null;
    scriptId: number | null;
    start: number | null;
    end: number | null;
    line: number | null;
    column: number | null;
    functionName: string | null;
    allocationStart: number | null;
    allocationEnd: number | null;
    // Local to the source thread's events; absent when the source is not a trace event.
    eventIndex: number | null;
    event: null;
    callFrame: null;
}
export type UniformProfile = V8CpuProfile;
export type UniformTraceEvent = {
    name: string;
    cat: string;
    tm: number;
    duration: number;
    eventId: string | number | null;
    sampleTraceId: number | null;
    data: unknown;
}
