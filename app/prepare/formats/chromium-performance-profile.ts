// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

import type { V8CpuProfile, V8CpuProfileSet } from '../types.js';

export type ChromiumTraceEventsProfile = {
    traceEvents: ChromiumTraceEvent[]
} & {
    [key: string]: unknown;
};

type ChromiumTraceProfileData = {
    cpuProfile: V8CpuProfile;
    timeDeltas: number[];
    lines: number[];
    columns: number[];
    startTime: number;
    endTime: number;
};

interface ChromiumTraceEvent {
    pid: number;
    tid: number;
    ts: number;
    ph: string;
    cat: string;
    name: string;
    dur: number;
    tdur: number;
    tts: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: { [key: string]: any };
    id?: string;
}

export function isChromiumPerformanceProfile(data: unknown): data is ChromiumTraceEventsProfile {
    if (!Array.isArray(data)) {
        // JSON Object Format
        return typeof data === 'object' && data !== null && 'traceEvents' in data
            ? isChromiumPerformanceProfile(data.traceEvents)
            : false;
    }

    if (data.length === 0) {
        return true;
    }

    const first = data[0];

    if (!('pid' in first && 'tid' in first && 'ph' in first && 'cat' in first)) {
        return false;
    }

    return true;
}

export function extractFromChromiumPerformanceProfile(
    events: ChromiumTraceEventsProfile | ChromiumTraceEvent[]
): V8CpuProfileSet {
    // It seems like sometimes Chrome timeline files contain multiple CpuProfiles?
    // For now, choose the first one in the list.
    const cpuProfileById = new Map<string, V8CpuProfile>();

    // Maps pid/tid pairs to thread names
    const processNameId = new Map<number, string>();
    const threadNameId = new Map<number, string>();

    // JSON Object Format
    if ('traceEvents' in events) {
        events = events.traceEvents;
    }

    // Filter only necessary events and sort them since the events do not have
    // to be in timestamp-sorted order
    events = events
        .filter(e =>
            e.name === 'CpuProfile' ||
            e.name === 'Profile' ||
            e.name === 'ProfileChunk' ||
            e.name === 'process_name' ||
            e.name === 'thread_name'
        )
        .sort((a, b) => a.ts - b.ts);

    for (const event of events) {
        if (event.name === 'CpuProfile') {
            // Create an arbitrary profile id.
            const profileId = `${event.pid}:0x1`;
            const profile = event.args.data.cpuProfile as V8CpuProfile;

            cpuProfileById.set(profileId, profile);
            // profile.threadId = event.tid;
        }

        if (event.name === 'Profile') {
            const profileId = `${event.pid}:${event.id}`;
            const profile: V8CpuProfile = {
                _name: threadNameId.get(event.tid) || null,
                startTime: 0,
                endTime: 0,
                nodes: [],
                samples: [],
                timeDeltas: [],
                trace_ids: {},
                lines: [],
                columns: [],
                ...event.args.data as Partial<V8CpuProfile>
            };
            // profile.threadId = event.tid;

            cpuProfileById.set(profileId, profile);
        }

        if (event.name === 'thread_name') {
            threadNameId.set(event.tid, event.args.name);
        }

        if (event.name === 'process_name') {
            processNameId.set(event.pid, event.args.name);
        }

        if (event.name === 'ProfileChunk') {
            const profileId = `${event.pid}:${event.id}`;
            const cpuProfile = cpuProfileById.get(profileId);
            const chunk: ChromiumTraceProfileData = event.args.data;

            if (!cpuProfile) {
                console.warn(`Ignoring ProfileChunk for undeclared Profile with id ${profileId}`);
                continue;
            }

            for (const chunkKey of Object.keys(chunk) as (keyof ChromiumTraceProfileData)[]) {
                switch (chunkKey) {
                    case 'cpuProfile': {
                        const { nodes, samples, trace_ids: traceIds } = chunk.cpuProfile;

                        if (Array.isArray(nodes)) {
                            (cpuProfile.nodes as unknown[]).push(...nodes);
                        }

                        if (Array.isArray(samples)) {
                            cpuProfile.samples.push(...samples);
                        }

                        if (traceIds) {
                            Object.assign(cpuProfile.trace_ids!, traceIds);
                        }

                        break;
                    }

                    case 'timeDeltas':
                        cpuProfile.timeDeltas.push(...chunk.timeDeltas);
                        break;

                    case 'lines':
                        cpuProfile.lines!.push(...chunk.lines);
                        break;

                    case 'columns':
                        cpuProfile.columns!.push(...chunk.columns);
                        break;

                    case 'startTime':
                    case 'endTime':
                        cpuProfile[chunkKey] = chunk[chunkKey];
                        break;
                }
            }
        }
    }

    if (cpuProfileById.size === 0) {
        throw new Error('Could not find CPU profile in Timeline');
    }

    const profiles: V8CpuProfile[] = [];
    let indexToView = -1;

    for (const [profileId, profile] of cpuProfileById) {
        const processName: string | null = processNameId.get(parseInt(profileId)) || 'Unknown';

        if (processName === 'CrRendererMain') {
            indexToView = profiles.length;
        }

        profiles.push(profile);
    }

    if (indexToView === -1) {
        indexToView = profiles.reduce(
            (res, profile, idx, array) => array[res].nodes.length < profile.nodes.length ? idx : res,
            0
        );
    }

    return {
        indexToView,
        profiles
    };
}
