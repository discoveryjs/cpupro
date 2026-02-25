import { RuntimeCode, V8CpuProfile, V8CpuProfileScript } from '../types';

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
}
export type UniformProcess = {
    pid: number;
    name: string | null;
}
export type UniformThread = {
    pid: number;
    tid: number;
    name: string | null;
    scripts: V8CpuProfileScript[];
    events: UniformTraceEvent[];
    userTimings: UniformTraceEvent[];
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
