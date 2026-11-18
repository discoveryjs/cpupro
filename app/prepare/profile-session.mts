import { Dictionary } from './dictionary.js';
import { Ownership, UniformProfile, UniformProfilingSession } from './formats/types.js';
import type { UniformHeapSnapshot } from './formats/heap-snapshot.js';
import { CpuProProcess, CpuProSession, CpuProThread } from './types.js';
import { createCompilationRecords } from './preprocessing/compilation-events.js';
import { indexCompilationStages, prepareCompilationSubjects } from './preprocessing/script-compilation.js';

export type DatasetProfile = {
    thread: CpuProThread;
    profile: UniformProfile;
};
export type DatasetHeapSnapshot = {
    thread: CpuProThread;
    heapSnapshot: UniformHeapSnapshot;
};
export type DatasetSession = {
    session: CpuProSession;
    profiles: DatasetProfile[];
    heapSnapshots: DatasetHeapSnapshot[];
}

export function createProfileSession(rawSession: UniformProfilingSession, dict: Dictionary): DatasetSession {
    const processes: CpuProProcess[] = [];
    const processesMap = new Map<number | null, CpuProProcess>();
    const threads: CpuProThread[] = [];
    const threadsMap = new Map<string, CpuProThread>();
    const profiles: DatasetProfile[] = [];
    const heapSnapshots: DatasetHeapSnapshot[] = [];
    const session: CpuProSession = {
        name: rawSession.name ?? null,
        runtime: rawSession.runtime ?? null,
        startTime: rawSession.startTime ?? null,
        source: rawSession.source ?? null,
        dataOrigin: rawSession.dataOrigin ?? null,
        ownership: copyOwnership(rawSession.ownership ?? null),
        processes,
        defaultProcess: null,
        profiles: [],
        defaultProfile: null,
        heapSnapshots: [],
        shared: {
            scripts: dict.scripts,
            locations: dict.locations,
            callFrames: dict.callFrames,
            modules: dict.modules,
            packages: dict.packages,
            categories: dict.categories,
            owners: dict.owners
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
        const { scripts, ...threadData } = rawThread;
        const thread: CpuProThread = Object.assign(
            createThread(rawThread.pid, rawThread.tid),
            threadData
        );

        thread.scripts = scripts.map(script => ({
            id: script.id,
            url: script.url,
            source: script.source,
            sourceMapUrl: script.sourceMapUrl,
            lineOffset: script.lineOffset,
            columnOffset: script.columnOffset,
            script: null,
            compilation: null
        }));

        if (rawThread.compilations) {
            thread.compilations = createCompilationRecords(rawThread.compilations, thread.events);
            thread.compilationSubjects = prepareCompilationSubjects(thread.compilations);
            thread.compilationStages = indexCompilationStages(thread.compilations);
        }
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

    // A heap snapshot has no thread in the input, it takes a thread of its own
    for (const rawHeapSnapshot of rawSession.heapSnapshots ?? []) {
        heapSnapshots.push({
            thread: createThread(null, null),
            heapSnapshot: rawHeapSnapshot
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
        profiles,
        heapSnapshots
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
            heapSnapshots: [],
            scripts: [],
            events: [],
            counters: [],
            userTimings: []
        };

        threads.push(thread);

        if (threadId !== null) {
            threadsMap.set(threadId, thread);
        }

        return thread;
    }
}

// Areas of files are kept for queries (see lookupAreas) by a copy of their own, rather than the input record
function copyOwnership(ownership: Ownership | null): Ownership | null {
    if (ownership === null) {
        return null;
    }

    const files: Ownership['files'] = {};

    for (const [path, areas] of Object.entries(ownership.files)) {
        files[path] = areas.slice();
    }

    return {
        api: ownership.api,
        areas: ownership.areas.slice(),
        files
    };
}
