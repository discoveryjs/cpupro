import { Dictionary } from './dictionary.js';
import { UniformProfile, UniformProfilingSession } from './formats/types.js';
import { CpuProProcess, CpuProSession, CpuProThread } from './types.js';

export type ThreadProfile = {
    thread: CpuProThread;
    profile: UniformProfile;
};
export type ProfileSession = {
    session: CpuProSession;
    profiles: ThreadProfile[];
}

export function createProfileSession(rawSession: UniformProfilingSession, dict: Dictionary): ProfileSession {
    const processes: CpuProProcess[] = [];
    const processesMap = new Map<number | null, CpuProProcess>();
    const threads: CpuProThread[] = [];
    const threadsMap = new Map<string, CpuProThread>();
    const profiles: ThreadProfile[] = [];
    const session: CpuProSession = {
        name: rawSession.name ?? null,
        runtime: rawSession.runtime ?? null,
        startTime: rawSession.startTime ?? null,
        source: rawSession.source ?? null,
        dataOrigin: rawSession.dataOrigin ?? null,
        ownership: rawSession.ownership ?? null,
        processes,
        defaultProcess: null,
        profiles: [],
        defaultProfile: null,
        shared: {
            scripts: dict.scripts,
            locations: dict.locations,
            callFrames: dict.callFrames,
            modules: dict.modules,
            packages: dict.packages,
            categories: dict.categories
        } as const
    } as const;

    // Pre-fill processes
    for (const rawProcess of rawSession.processes || []) {
        Object.assign(createProcess(rawProcess.pid), {
            name: rawProcess.name ?? null
        } satisfies Partial<CpuProProcess>);
    }

    // Pre-fill threads
    for (const rawThread of rawSession.threads || []) {
        Object.assign(createThread(rawThread.pid, rawThread.tid), rawThread);
    }

    // Produce profile list with resolved thread references, create missing threads if needed
    for (const rawProfile of rawSession.profiles) {
        const pid = rawProfile._pid ?? null;
        const tid = rawProfile._tid ?? null;
        const threadId = resolveThreadId(pid, tid);
        const thread = (threadId ? threadsMap.get(threadId) : null) ?? createThread(pid, tid);

        profiles.push({
            thread,
            profile: rawProfile
        });
    }

    // Finalize processes and threads relations, create missing processes if needed
    for (const thread of threads) {
        const process = processesMap.get(thread.pid) ?? createProcess(thread.pid);

        process.threads.push(thread);
        thread.process = process;
    }

    return {
        session,
        profiles
    };

    //
    // Helpers
    //

    function createProcess(pid: number | null): CpuProProcess {
        const process: CpuProProcess = {
            pid,
            name: null,
            session,
            threads: []
        };

        processes.push(process);

        if (typeof process.pid === 'number') {
            processesMap.set(process.pid, process);
        }

        return process;
    }

    function resolveThreadId(pid: number | null, tid: number | null): string | null {
        return typeof pid === 'number' && typeof tid === 'number'
            ? `${pid}:${tid}`
            : null;
    }

    function createThread(pid: number | null, tid: number | null): CpuProThread {
        const threadId = resolveThreadId(pid, tid);
        const thread = {
            pid,
            tid,
            name: null,
            process: null,
            profiles: [],
            events: [],
            userTimings: []
        };

        threads.push(thread);

        if (threadId !== null) {
            threadsMap.set(threadId, thread);
        }

        return thread;
    }
}
