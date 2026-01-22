// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

import type { SourceMap, CpuProTraceEvent, V8CpuProfile, V8CpuProfileScript, V8CpuProfileSet } from '../types.js';

export type ChromiumTraceEventsProfile = {
    traceEvents: ChromiumTraceEvent[];
    metadata?: {
        sourceMaps?: ProfileSourceMap[];
    };
};

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
    types?: number[];
    typesDict?: Record<string, string>;
    spaces?: number[];
    spacesDict?: Record<string, string>;
    gc?: number[];
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
};
type ChromiumTraceProfileData = {
    name: string | null;
    pid: number;
    tid: number;
    startTime: number;
    endTime: number;
    scripts: Map<number, V8CpuProfileScript>;
    traceEvents: CpuProTraceEvent[];
    chunks: ChromiumTraceProfileChunkEventData[];
    samples: number;
    hasLineColumns: boolean;
    hasAllocationsMapping: boolean;
    allocations: number;
    allocationChunks: AllocationSamples[];
}

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
    const profileById = new Map<string, V8CpuProfile>();
    const profileDataById = new Map<string, ChromiumTraceProfileData>();
    const profileDataByTid = new Map<string, ChromiumTraceProfileData>();
    const profileByTid = new Map<string, V8CpuProfile>();

    // Maps pid/tid pairs to thread names
    const processNameId = new Map<number, string>();
    const threadNameId = new Map<number, string>();
    let sourceMaps: ProfileSourceMap[] = [];

    // JSON Object Format
    if ('traceEvents' in events) {
        sourceMaps = events.metadata?.sourceMaps || [];
        events = events.traceEvents;
    }

    // Filter only necessary events and sort them since the events do not have
    // to be in timestamp-sorted order
    events = events
        .slice()
        // .filter(e =>
        //     e.name === 'CpuProfile' ||
        //     e.name === 'Profile' ||
        //     e.name === 'ProfileChunk' ||
        //     e.name === 'ScriptCatchup' ||
        //     e.name === 'LargeScriptCatchup' ||
        //     e.name === 'MinorGC' ||
        //     e.name === 'MajorGC' ||
        //     e.name === 'process_name' ||
        //     e.name === 'thread_name'
        // )
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
                const profile: V8CpuProfile = {
                    _name: threadNameId.get(event.tid) || null,
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
                // profile.threadId = event.tid;
                profileById.set(profileId, profile);
                profileByTid.set(`${event.pid}:${event.tid}`, profile);

                const profileData: ChromiumTraceProfileData = {
                    name: threadNameId.get(event.tid) || null,
                    pid: event.pid,
                    tid: event.tid,
                    startTime: (event.args.data as Partial<V8CpuProfile>).startTime || 0,
                    endTime: 0,
                    scripts: new Map(),
                    traceEvents: [],
                    chunks: [],
                    samples: 0,
                    hasLineColumns: false,
                    hasAllocationsMapping: false,
                    allocations: 0,
                    allocationChunks: []
                };

                profileDataById.set(profileId, profileData);
                profileDataByTid.set(`${event.pid}:${event.tid}`, profileData);
                break;
            }

            case 'thread_name': {
                threadNameId.set(event.tid, event.args.name);
                break;
            }

            case 'process_name': {
                processNameId.set(event.pid, event.args.name);
                break;
            }

            case 'ScriptCatchup':
            case 'LargeScriptCatchup': {
                const profileData = profileDataByTid.get(`${event.pid}:${event.tid}`);

                if (!profileData) {
                    console.warn(`Ignoring ${event.name} for undeclared Profile (pid: ${event.pid}, tid: ${event.tid})`);
                    break;
                }

                const scripts = profileData.scripts;
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
                const profileData = profileDataByTid.get(`${event.pid}:${event.tid}`);

                if (!profileData) {
                    console.warn(`Ignoring ${event.name} for undeclared Profile (pid: ${event.pid}, id: ${event.id})`);
                    continue;
                }

                profileData.traceEvents.push({
                    name: event.name,
                    cat: event.cat,
                    tm: event.ts,
                    duration: event.dur,
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
                const profileData = profileDataById.get(`${event.pid}:${event.id}`);

                if (!profileData) {
                    console.warn(`Ignoring ProfileChunk for undeclared Profile (pid: ${event.pid}, id: ${event.id})`);
                    continue;
                }

                profileData.chunks.push(chunk);
                profileData.hasLineColumns ||= Array.isArray(chunk.lines) && Array.isArray(chunk.columns);
                profileData.hasAllocationsMapping ||= Array.isArray(chunk.allocationSampleIds) && chunk.allocationSampleIds.length > 0;

                const { cpuProfile, allocationSamples, endTime } = chunk;

                if (cpuProfile) {
                    profileData.samples += cpuProfile.samples?.length ?? 0;
                }

                if (allocationSamples) {
                    profileData.allocations += allocationSamples.ids.length;
                    profileData.allocationChunks.push(allocationSamples);
                }

                if (endTime && endTime > profileData.endTime) {
                    profileData.endTime = endTime;
                }
            }

            default: {
                let sampleTraceId: number | null = null;
                let data: unknown = null;

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
                    const profileData = profileDataByTid.get(`${event.pid}:${event.tid}`);

                    if (!profileData) {
                        console.warn(`Ignoring ${event.name} for undeclared Profile (pid: ${event.pid}, tid: ${event.tid})`);
                        break;
                    }

                    profileData.traceEvents.push({
                        name: event.name,
                        cat: event.cat,
                        tm: event.ts,
                        duration: event.dur || 0,
                        sampleTraceId,
                        data
                    });
                }
            }
        }
    }

    if (profileById.size === 0) {
        throw new Error('Could not find CPU profile in Timeline');
    }

    const profiles: V8CpuProfile[] = [];
    let indexToView = -1;

    for (const [profileId, profileData] of profileDataById) {
        const processName: string | null = processNameId.get(parseInt(profileId)) || 'Unknown';
        const { name, pid, tid, startTime, endTime, scripts, chunks, samples, allocationChunks } = profileData;
        const profile: V8CpuProfile = {
            _name: name,
            _pid: pid,
            _tid: tid,
            startTime,
            endTime,
            nodes: [],
            samples: buildChunkedArray('samples', chunks, samples),
            timeDeltas: buildChunkedArray('timeDeltas', chunks, samples),
            trace_ids: {},
            lines: undefined,
            columns: undefined,
            _cpuproTraceEvents: profileData.traceEvents
        };

        if (processName === 'CrRendererMain') {
            indexToView = profiles.length;
        }

        if (scripts) {
            profile._scripts = Array.from(scripts.values());

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
        console.log({
            traceEvents: profileData.traceEvents,
            trace_ids: profile.trace_ids
        });

        if (profileData.hasLineColumns) {
            profile.lines = buildChunkedArray('lines', chunks, samples);
            profile.columns = buildChunkedArray('columns', chunks, samples);
        }

        if (profileData.hasAllocationsMapping) {
            profile._cpuproAllocationMapping = buildChunkedArray('allocationSampleIds', chunks, samples);
        }

        if (allocationChunks.length > 0) {
            profile._cpuproAllocationIds = buildChunkedVector(allocationChunks, 'ids');
            profile._cpuproAllocationSizes = buildChunkedVector(allocationChunks, 'sizes');
            profile._cpuproAllocationTypes = buildChunkedVector(allocationChunks, 'types');
            profile._cpuproAllocationTypeNames = buildChunkedMap(profile._cpuproAllocationTypes, allocationChunks, 'typesDict');
            profile._cpuproAllocationSpaces = buildChunkedVector(allocationChunks, 'spaces');
            profile._cpuproAllocationSpaceNames = buildChunkedMap(profile._cpuproAllocationSpaces, allocationChunks, 'spacesDict');
            profile._cpuproAllocationGc = buildChunkedVector(allocationChunks, 'gc');
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

function buildChunkedVector(chunks: AllocationSamples[], key: Exclude<keyof AllocationSamples, 'typesDict' | 'spacesDict'>): number[] | undefined {
    const vector = chunks.flatMap(chunk => chunk[key] || []);
    return vector.length ? vector : undefined;
}

function buildChunkedMap(
    vector: number[] | undefined,
    chunks: AllocationSamples[],
    key: 'typesDict' | 'spacesDict'
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
