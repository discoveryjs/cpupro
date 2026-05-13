// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

import type { SourceMap, V8CpuProfile, V8CpuProfileScript } from '../types.js';
import { UniformProcess, UniformProfilingSession, UniformThread, UniformTraceEvent } from './types.js';

export type ChromiumTraceEventsMetadata = {
    startTime?: string;
    source?: string;
    dataOrigin?: string;
    sourceMaps?: ProfileSourceMap[];
};
export type ChromiumTraceEventsSource = {
    traceEvents: ChromiumTraceEvent[];
    metadata?: ChromiumTraceEventsMetadata;
};

type EventChannel = {
    thread: UniformThread;
    events: UniformThread['events'];
    userTimings: UniformThread['userTimings'];
    traceEventsBE: Map<string | number, UniformTraceEvent>;
    traceEventsSF: Map<string | number, UniformTraceEvent>;
    scripts: Map<number, V8CpuProfileScript>;
}
type ProfileSourceMap = {
    url: string;
    sourceMapUrl: string;
    sourceMap: SourceMap;
}
type ScriptCatchupEventData = {
    scriptId: number;
    url: string;
    sourceText: string;
    sourceMapUrl: string;
}
type AllocationSamples = {
    ids: number[];
    sizes?: number[];
    scriptIds?: number[];
    scriptOffsets?: number[];
    contextInfo?: number[]; // vm state + builtin id
    builtinsDict?: Record<number, string>;
    vmStatesDict?: Record<number, string>;
    types?: number[];
    typesDict?: Record<string, string>;
    spaces?: number[];
    spacesDict?: Record<string, string>;
    gc?: number[];
};
type AllocationGc = {
    [key in number]: number[];
};
type ChromiumTraceProfileChunkEventData = {
    cpuProfile: V8CpuProfile;
    timeDeltas: number[];
    lines: number[];
    columns: number[];
    startTime: number;
    endTime: number;
    // Combined profile allocation data
    allocationSampleIds?: number[];
    allocationSamples?: AllocationSamples;
    allocationGc?: AllocationGc;
};
type ChromiumTraceProfileData = {
    pid: number;
    tid: number;
    eventChannel: EventChannel;
    startTime: number;
    endTime: number;
    chunks: ChromiumTraceProfileChunkEventData[];
    samples: number;
    hasLineColumns: boolean;
    hasAllocationsMapping: boolean;
    allocationChunks: AllocationSamples[];
    allocationGcs: AllocationGc[];
}

interface ChromiumTraceEvent {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: { [key: string]: any };
    name: string;
    cat: string;
    pid: number;
    tid: number;
    ts: number;
    ph: string;
    dur?: number;
    tdur?: number;
    tts?: number;
    id?: string | number;
    id2?: { local: string | number };
}

export function isChromiumPerformanceProfile(data: unknown): data is ChromiumTraceEventsSource {
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

function getEventThreadId(event: { pid: number; tid: number }): string {
    return `${event.pid}:${event.tid}`;
}

function getOrCreateProcess(event: ChromiumTraceEvent, processes: Map<number, UniformProcess>): UniformProcess {
    let process = processes.get(event.pid);

    if (!process) {
        processes.set(event.pid, process = {
            pid: event.pid,
            name: null
        });
    }

    return process;
};

function getOrCreateEventChannel(event: { pid: number; tid: number }, eventChannels: Map<string, EventChannel>): EventChannel {
    const threadId = getEventThreadId(event);
    let eventChannel = eventChannels.get(threadId);

    if (!eventChannel) {
        const events = [];
        const userTimings = [];

        eventChannels.set(threadId, eventChannel = {
            thread: {
                pid: event.pid,
                tid: event.tid,
                name: null,
                scripts: [],
                events,
                userTimings
            },
            events,
            userTimings,
            traceEventsBE: new Map(),
            traceEventsSF: new Map(),
            scripts: new Map()
        });
    }

    return eventChannel;
};

function getEventId(event: ChromiumTraceEvent): string | number | null {
    if (event.ph === 'b' || event.ph === 'e') {
        const id = event.id ?? event.id2?.local ?? null;
        return id !== null ? `${event.name}:${id}` : null;
    }

    if (event.ph === 's' || event.ph === 'f') {
        return event.id ?? null;
    }

    return null;
}

function addTraceEventToThread(
    threadsMap: Map<string, EventChannel>,
    event: ChromiumTraceEvent,
    data: unknown,
    sampleTraceId: number | null = null
) {
    const thread = getOrCreateEventChannel(event, threadsMap);
    const eventId = getEventId(event);
    const eventMap = event.ph === 'b' || event.ph === 'e'
        ? thread.traceEventsBE
        : thread.traceEventsSF;
    let tm = event.ts;
    let duration = event.dur || 0;

    if (event.ph === 'e' || event.ph === 'f') {
        if (eventId === null) {
            console.warn(`Ignoring ${event.cat}/${event.name} end event without id (pid: ${event.pid}, tid: ${event.tid})`);
            return;
        }

        const startEvent = eventMap.get(eventId);

        if (startEvent) {
            startEvent.duration = tm - startEvent.tm;
            eventMap.delete(eventId);
            return;
        } else {
            console.warn(`Could not find start event for end event with id ${eventId}`, event);
            duration = tm;
            tm = -1;
        }
    }

    const traceEvent: UniformTraceEvent = {
        name: event.name,
        cat: event.cat,
        tm,
        duration,
        eventId,
        sampleTraceId,
        data
    };
    // traceEvent.event = event;

    if (event.ph === 'b' || event.ph === 's') {
        if (eventId === null) {
            console.warn(`Ignoring ${event.cat}/${event.name} begin event without id (pid: ${event.pid}, tid: ${event.tid})`);
            return;
        }

        eventMap.set(eventId, traceEvent);
        traceEvent.duration = -1;
    }

    if (event.cat === 'blink.user_timing') {
        thread.userTimings.push(traceEvent);
    } else {
        thread.events.push(traceEvent);
    }
}

export function extractFromChromiumPerformanceProfile(
    events: ChromiumTraceEventsSource | ChromiumTraceEventsSource['traceEvents']
): UniformProfilingSession {
    // Chrome tracing contain multiple CpuProfile events
    const profileById = new Map<string, V8CpuProfile>();
    const profileDataByTid = new Map<string, ChromiumTraceProfileData>();
    const profileDataById = new Map<string, ChromiumTraceProfileData>();
    const profileDataByIsolate = new Map<string, ChromiumTraceProfileData>();
    const profiles: V8CpuProfile[] = [];

    // Maps pid/tid pairs to thread names
    const processesMap = new Map<number, UniformProcess>();
    const eventChannels = new Map<string, EventChannel>();

    // Metadata and source maps
    let metadata: ChromiumTraceEventsMetadata = {};
    let sourceMaps: ProfileSourceMap[] = [];

    // JSON Object Format
    if ('traceEvents' in events) {
        metadata = events.metadata || {};
        sourceMaps = metadata.sourceMaps || [];
        events = events.traceEvents;
    }

    // Filter only necessary events and sort them since the events do not have
    // to be in timestamp-sorted order
    events = events
        .slice()
        .sort((a, b) => a.ts - b.ts);

    for (const event of events) {
        switch (event.name) {
            case 'CpuProfile': {
                // Create an arbitrary profile id.
                const profileId = `${event.pid}:0x1`;
                const profile = event.args.data.cpuProfile as V8CpuProfile;

                profileById.set(profileId, profile);
                // profile.threadId = event.tid;
                break;
            }

            case 'Profile': {
                const profileId = `${event.pid}:${event.id}`;
                const eventChannel = getOrCreateEventChannel(event, eventChannels);
                const threadId = getEventThreadId(event);
                const profile: V8CpuProfile = {
                    _name: null,
                    _pid: event.pid,
                    _tid: event.tid,
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
                profileById.set(threadId, profile);

                const profileData: ChromiumTraceProfileData = {
                    eventChannel,
                    pid: event.pid,
                    tid: event.tid,
                    startTime: (event.args.data as Partial<V8CpuProfile>).startTime || 0,
                    endTime: 0,
                    chunks: [],
                    samples: 0,
                    hasLineColumns: false,
                    hasAllocationsMapping: false,
                    allocationChunks: [],
                    allocationGcs: []
                };

                profileDataById.set(profileId, profileData);
                profileDataByTid.set(threadId, profileData);

                if (event.args.isolate) {
                    profileDataByIsolate.set(event.args.isolate, profileData);
                }
                break;
            }

            case 'thread_name': {
                getOrCreateEventChannel(event, eventChannels).thread.name = event.args.name;
                break;
            }

            case 'process_name': {
                getOrCreateProcess(event, processesMap).name = event.args.name;
                break;
            }

            case 'ScriptCatchup':
            case 'LargeScriptCatchup': {
                const eventChannel = getOrCreateEventChannel(event, eventChannels);
                const scripts = eventChannel.scripts;
                const props = event.args.data as unknown as ScriptCatchupEventData;
                const scriptId = Number(props.scriptId);
                let script = scripts.get(scriptId);

                if (!script) {
                    scripts.set(scriptId, script = {
                        id: scriptId,
                        url: null as unknown as string,
                        source: null as unknown as string,
                        sourceMapUrl: null,
                        sourceMap: null
                    });
                    eventChannel.thread.scripts.push(script);
                }

                for (const key of Object.keys(props)) {
                    switch (key) {
                        case 'url':
                            script[key] = props[key];
                            break;
                        case 'sourceMapUrl': {
                            script.sourceMapUrl = props.sourceMapUrl;
                            break;
                        }
                        case 'sourceText':
                            script.source = script.source === null
                                ? props.sourceText
                                : script.source + props.sourceText;
                            break;
                    }
                }
                break;
            }

            case 'MinorGC':
            case 'MajorGC': {
                getOrCreateEventChannel(event, eventChannels).events.push({
                    name: event.name,
                    cat: event.cat,
                    tm: event.ts,
                    duration: event.dur ?? 0,
                    eventId: null,
                    sampleTraceId: null,
                    data: {
                        reason: event.args?.type || '',
                        usedHeapSizeBefore: event.args?.usedHeapSizeBefore || 0,
                        usedHeapSizeAfter: event.args?.usedHeapSizeAfter || 0
                    }
                });

                break;
            }

            case 'ProfileChunk': {
                const chunk: ChromiumTraceProfileChunkEventData = event.args.data;
                const profileData = event.args.isolate
                    ? profileDataByIsolate.get(event.args.isolate)
                    : profileDataById.get(`${event.pid}:${event.id}`);

                if (!profileData) {
                    console.warn(`Ignoring ProfileChunk for undeclared Profile (pid: ${event.pid}, id: ${event.id})`);
                    continue;
                }

                profileData.chunks.push(chunk);
                profileData.hasLineColumns ||= Array.isArray(chunk.lines) && Array.isArray(chunk.columns);
                profileData.hasAllocationsMapping ||= Array.isArray(chunk.allocationSampleIds) && chunk.allocationSampleIds.length > 0;

                const { cpuProfile, allocationSamples, allocationGc, endTime } = chunk;

                if (cpuProfile) {
                    profileData.samples += cpuProfile.samples?.length ?? 0;
                }

                if (allocationSamples) {
                    profileData.allocationChunks.push(allocationSamples);
                }

                if (allocationGc) {
                    profileData.allocationGcs.push(allocationGc);
                }

                if (endTime && endTime > profileData.endTime) {
                    profileData.endTime = endTime;
                }
            }

            default: {
                let sampleTraceId: number | null = null;
                let data: unknown = null;

                // FIXME: skip s/f events for now
                if (event.ph === 's' || event.ph === 'f') {
                    continue;
                }

                if (event.cat === 'disabled-by-default-devtools.timeline' &&
                    event.name === 'UpdateCounters') {
                    addTraceEventToThread(eventChannels, event, event.args.data);
                    break;
                }

                if ('sampleTraceId' in event.args) {
                    sampleTraceId = event.args.sampleTraceId;
                    data = event.args;
                } else if (typeof event.args.data?.sampleTraceId === 'number') {
                    sampleTraceId = event.args.data.sampleTraceId;
                    data = event.args.data;
                } else if (typeof event.args.beginData?.sampleTraceId === 'number') {
                    sampleTraceId = event.args.beginData.sampleTraceId;
                    data = event.args.beginData;
                }

                if (sampleTraceId !== null) {
                    addTraceEventToThread(eventChannels, event, data, sampleTraceId);
                } else if (event.cat === 'blink.user_timing') {
                    if (event.ph === 'b' || event.ph === 'e') {
                        addTraceEventToThread(eventChannels, event, event.args, event.args?.traceId || null);
                    }
                } else if (event.cat === 'disabled-by-default-v8.compile' ||
                    event.ph === 'X' || event.ph === 'b' || event.ph === 'e') {
                    addTraceEventToThread(eventChannels, event, event.args);
                }
            }
        }
    }

    if (profileById.size === 0) {
        throw new Error('Could not find CPU profile in Timeline');
    }

    for (const profileData of profileDataById.values()) {
        const { pid, tid, eventChannel, startTime, endTime, chunks, samples, allocationChunks, allocationGcs } = profileData;
        const { thread } = eventChannel;
        const profile: V8CpuProfile = {
            _name: thread.name,
            _pid: pid,
            _tid: tid,
            startTime,
            endTime,
            nodes: [],
            samples: buildChunkedArray('samples', chunks, samples),
            timeDeltas: buildChunkedArray('timeDeltas', chunks, samples),
            trace_ids: {},
            lines: undefined,
            columns: undefined
        };

        if (thread.scripts) {
            profile._scripts = Array.from(thread.scripts.values());

            for (const script of profile._scripts) {
                // Attach source map from trace file if available
                if (script.sourceMapUrl) {
                    try {
                        const sourceMapUrl = new URL(script.sourceMapUrl, script.url || undefined).toString();
                        const sourceMap = sourceMaps.find(sm => sm.sourceMapUrl === sourceMapUrl)?.sourceMap;
                        if (sourceMap && typeof sourceMap === 'object') {
                            script.sourceMap = sourceMap;
                        }
                    } catch (error) {
                        console.error('Error processing source map for script:', script, error);
                    }
                }
            }
        }

        for (const chunk of chunks) {
            if (chunk.cpuProfile) {
                if (chunk.cpuProfile.nodes) {
                    (profile.nodes as unknown[]).push(...chunk.cpuProfile.nodes);
                }
                if (chunk.cpuProfile.trace_ids) {
                    Object.assign(profile.trace_ids!, chunk.cpuProfile.trace_ids);
                }
            }
        }

        if (profileData.hasLineColumns) {
            profile.lines = buildChunkedArray('lines', chunks, samples);
            profile.columns = buildChunkedArray('columns', chunks, samples);
        }

        if (profileData.hasAllocationsMapping) {
            profile._cpuproAllocationMapping = buildChunkedArray('allocationSampleIds', chunks, samples);
        }

        if (allocationChunks.length > 0) {
            const ids = buildChunkedVector(allocationChunks, 'ids');
            const allocationsCount = ids ? ids.length : 0;

            profile._cpuproAllocationIds = ids;
            profile._cpuproAllocationSizes = buildChunkedVector(allocationChunks, 'sizes', allocationsCount);
            profile._cpuproAllocationScriptIds = buildChunkedVector(allocationChunks, 'scriptIds', allocationsCount);
            profile._cpuproAllocationLocations = buildChunkedVector(allocationChunks, 'scriptOffsets', allocationsCount);
            profile._cpuproAllocationContextInfo = buildChunkedVector(allocationChunks, 'contextInfo', allocationsCount);
            profile._cpuproAllocationBuiltinNames = buildChunkedMap(profile._cpuproAllocationContextInfo, allocationChunks, 'builtinsDict');
            profile._cpuproAllocationVmStateNames = buildChunkedMap(profile._cpuproAllocationContextInfo, allocationChunks, 'vmStatesDict');
            profile._cpuproAllocationTypes = buildChunkedVector(allocationChunks, 'types', allocationsCount);
            profile._cpuproAllocationTypeNames = buildChunkedMap(profile._cpuproAllocationTypes, allocationChunks, 'typesDict');
            profile._cpuproAllocationSpaces = buildChunkedVector(allocationChunks, 'spaces', allocationsCount);
            profile._cpuproAllocationSpaceNames = buildChunkedMap(profile._cpuproAllocationSpaces, allocationChunks, 'spacesDict');
            profile._cpuproAllocationGc = buildChunkedVector(allocationChunks, 'gc', allocationsCount);

            if (allocationGcs.length > 0 && profile._cpuproAllocationGc) {
                const idToIndexMap = new Map<number, number>(ids?.map((id, index) => [id, index]) || []);
                for (const allocationGc of allocationGcs) {
                    for (const [key, value] of Object.entries(allocationGc)) {
                        const gc = parseInt(key);
                        const ids = typeof value === 'string' ? JSON.parse(value) : value;

                        for (const id of ids) {
                            const index = idToIndexMap.get(id);
                            if (index !== undefined) {
                                profile._cpuproAllocationGc[index] = gc;
                            }
                        }
                    }
                }
            }
        }

        profiles.push(profile);
    }

    return {
        name: null,
        runtime: 'unknown',
        startTime: metadata.startTime ?? null,
        source: metadata.source ?? null,
        dataOrigin: metadata.dataOrigin ?? null,

        buildId: null,
        setupId: null,
        scenarioId: null,

        processes: [...processesMap.values()],
        threads: [...eventChannels.values()]
            .map(({ thread }) => thread)
            .sort((a, b) => a.pid - b.pid || a.tid - b.tid),

        profiles
    };
}

function buildChunkedVector(
    chunks: AllocationSamples[],
    key: Exclude<keyof AllocationSamples, 'typesDict' | 'spacesDict' | 'builtinsDict' | 'vmStatesDict'>,
    totalLength: number = 0
): number[] | undefined {
    const vector: number[] = totalLength > 0
        ? new Uint32Array(totalLength) as unknown as number[]
        : chunks.flatMap(chunk =>
            typeof chunk[key] === 'string' ? JSON.parse(chunk[key]) : chunk[key] || []
        );

    if (totalLength > 0) {
        let offset = 0;
        for (const chunk of chunks) {
            const array = typeof chunk[key] === 'string' ? JSON.parse(chunk[key]) : chunk[key];

            (vector as unknown as Uint32Array).set(array, offset);
            offset += array.length;
        }
    }

    return vector.length ? vector as number[] : undefined;
}

function buildChunkedMap(
    vector: number[] | undefined,
    chunks: AllocationSamples[],
    key: 'typesDict' | 'spacesDict' | 'builtinsDict' | 'vmStatesDict'
): Record<string, string> | undefined {
    if (!vector || vector.length === 0) {
        return undefined;
    }

    const result: Record<string, string> = {};

    for (const chunk of chunks) {
        const dict = chunk[key];

        if (dict) {
            Object.assign(result, dict);
        }
    }

    return result;
}

function buildChunkedArray(
    key: 'samples' | 'timeDeltas' | 'lines' | 'columns' | 'allocationSampleIds',
    chunks: ChromiumTraceProfileChunkEventData[],
    totalLength: number
): number[] {
    const result: number[] = new Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        const array = key === 'samples'
            ? chunk.cpuProfile?.[key]
            : chunk[key];

        if (Array.isArray(array)) {
            for (let i = 0; i < array.length; i++) {
                result[offset++] = array[i];
            }
        } else {
            if (chunk.timeDeltas) {
                for (let i = 0; i < chunk.timeDeltas.length; i++) {
                    result[offset++] = 0;
                }
            }
        }
    }

    return result;
}
