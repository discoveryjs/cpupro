// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

import { getNumericArrayOrder } from './utils.js';
import { isInt32Vector, isNumberVector, isUint32Vector } from '../misc/utils.js';
import { type Diagnose, diagnoseToConsole } from '../diagnostics.js';
import type {
    Ownership,
    UniformCompilationRecord,
    UniformProcess,
    UniformProfilingSession,
    UniformThread,
    UniformTraceEvent
} from './types.js';
import type {
    AllocationCodeTypeVector,
    AllocationContextInfoVector,
    AllocationGcVector,
    AllocationIdVector,
    AllocationSizeVector,
    AllocationSpaceVector,
    AllocationTypeVector,
    ColumnNumberVector,
    LineNumberVector,
    ScriptOffsetVector,
    SourceMap,
    TimeDeltaVector,
    V8CpuProfile,
    V8CpuProfileScript
} from '../types.js';

export type ChromiumTraceEventsMetadata = {
    startTime?: string;
    source?: string;
    dataOrigin?: string;
    sourceMaps?: ProfileSourceMap[];
    ownership?: Ownership;
    allocationVectors?: AllocationVectorEntry[];
};
// The jsonxl trace layout moves ProfileChunk allocation vectors into metadata, leaving null
// in the chunks: one vector per producer (pid and tid of the chunk events) and name, e.g.
// "allocationSamples.ids" or "allocationGc.9", holding the concatenation over the producer's chunks
type AllocationVectorEntry = {
    pid: number;
    tid: number;
    name: string;
    data: TraceAllocationIdVector | Int32Array;
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
    lineOffset?: number;
    columnOffset?: number;
    splitCount?: number;
    splitIndex?: number;
}
type ScriptSourceChunks = Map<V8CpuProfileScript, {
    splitCount: number;
    chunks: Map<number, string>;
}>;
type TraceAllocationIdVector = AllocationIdVector; // Exclude<AllocationIdVector, Uint32Array>;
type TraceScriptIdVector = number[] | Int32Array;
type AllocationSamples = {
    ids?: TraceAllocationIdVector | string;
    sizes?: AllocationSizeVector | string;
    scriptIds?: TraceScriptIdVector | string;
    scriptOffsets?: ScriptOffsetVector | string;
    contextInfo?: AllocationContextInfoVector | string; // vm state + builtin id
    builtinsDict?: Record<number, string>;
    vmStatesDict?: Record<number, string>;
    types?: AllocationTypeVector | string;
    typesDict?: Record<string, string>;
    spaces?: AllocationSpaceVector | string;
    spacesDict?: Record<string, string>;
    codeTypes?: AllocationCodeTypeVector | string;
    codeTypesDict?: Record<string, string>;
    gc?: AllocationGcVector | string;
};
type AllocationGc = {
    [key: string]: TraceAllocationIdVector | string;
};
// Allocation vectors after prepareChunkVectors() decoded them in place
type DecodedAllocationSamples = {
    [Key in keyof AllocationSamples]: Exclude<AllocationSamples[Key], string>;
};
type DecodedAllocationGc = {
    [key: string]: Exclude<AllocationGc[string], string>;
};
const signedAllocationKeys = ['scriptIds', 'scriptOffsets'] as const;
const unsignedAllocationKeys = ['sizes', 'contextInfo', 'types', 'spaces', 'codeTypes', 'gc'] as const;
type CompilationAllocationEventData = {
    isolate?: string;
    scriptId?: number;
    start?: number;
    end?: number;
    line?: number;
    column?: number;
    startAllocationId?: number;
    endAllocationId?: number;
};
type ChromiumTraceProfileChunkEventData = {
    cpuProfile: V8CpuProfile;
    timeDeltas: TimeDeltaVector;
    lines: LineNumberVector;
    columns: ColumnNumberVector;
    startTime: number;
    endTime: number;
    isolate?: string;
    // Combined profile allocation data
    allocationSampleIds?: TraceAllocationIdVector | Int32Array;
    allocationSamples?: AllocationSamples;
    allocationGc?: AllocationGc;
};
type ChromiumTraceProfileData = {
    pid: number;
    tid: number;
    capture: NonNullable<V8CpuProfile['_capture']>;
    eventChannel: EventChannel;
    startTime: number;
    endTime: number;
    chunks: ChromiumTraceProfileChunkEventData[];
    samples: number;
    hasLineColumns: boolean;
    hasAllocationsMapping: boolean;
    allocationChunks: DecodedAllocationSamples[];
    allocationGcs: DecodedAllocationGc[];
    // producers of allocation chunks whose vectors are stored in metadata
    allocationVectorProducers: Set<string>;
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
        const events: UniformTraceEvent[] = [];
        const userTimings: UniformTraceEvent[] = [];

        eventChannels.set(threadId, eventChannel = {
            thread: {
                pid: event.pid,
                tid: event.tid,
                name: null,
                isolate: null,
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

// Repeated identical deliveries are normal; differing content is a suspected V8 tracing defect
function isConflictingSource(script: V8CpuProfileScript, source: string) {
    return typeof script.source === 'string' && script.source !== source;
}

function applyScriptSourceText(
    diagnose: Diagnose,
    scriptSourceChunks: ScriptSourceChunks,
    script: V8CpuProfileScript,
    event: ChromiumTraceEvent,
    props: ScriptCatchupEventData
) {
    const { sourceText } = props;
    const origin = { scriptId: script.id, pid: event.pid, tid: event.tid };

    if (typeof sourceText !== 'string') {
        diagnose('warn', 'Ignoring script source of a non-string type', {
            ...origin,
            type: typeof sourceText
        });
        return;
    }

    if (event.name === 'ScriptCatchup') {
        const pending = scriptSourceChunks.get(script);

        if (isConflictingSource(script, sourceText)) {
            diagnose('warn', 'Script source redelivered with different content', origin);
        }

        if (pending) {
            diagnose('warn', 'Script source snapshot discards incomplete chunks', {
                ...origin,
                received: pending.chunks.size,
                splitCount: pending.splitCount
            });
        }

        script.source = sourceText;
        scriptSourceChunks.delete(script);
        return;
    }

    const { splitCount = 0, splitIndex = -1 } = props;

    if (!Number.isInteger(splitCount) || splitCount <= 0 ||
        !Number.isInteger(splitIndex) || splitIndex < 0 || splitIndex >= splitCount) {
        diagnose('warn', 'Ignoring script source chunk with invalid split metadata', {
            ...origin,
            splitCount,
            splitIndex
        });
        return;
    }

    let sourceChunks = scriptSourceChunks.get(script);

    if (sourceChunks && sourceChunks.splitCount !== splitCount) {
        diagnose('warn', 'Script source split count changed, dropping incomplete chunks', {
            ...origin,
            splitCount: sourceChunks.splitCount,
            newSplitCount: splitCount,
            received: sourceChunks.chunks.size
        });
    }

    if (!sourceChunks || sourceChunks.splitCount !== splitCount) {
        scriptSourceChunks.set(script, sourceChunks = { splitCount, chunks: new Map() });
    }

    const previousChunk = sourceChunks.chunks.get(splitIndex);

    if (previousChunk !== undefined && previousChunk !== sourceText) {
        diagnose('warn', 'Script source chunk redelivered with different content', {
            ...origin,
            splitIndex
        });
    }

    sourceChunks.chunks.set(splitIndex, sourceText);

    if (sourceChunks.chunks.size === splitCount) {
        let source = '';

        for (let index = 0; index < splitCount; index++) {
            source += sourceChunks.chunks.get(index)!;
        }

        if (isConflictingSource(script, source)) {
            diagnose('warn', 'Script source redelivered with different content', origin);
        }

        script.source = source;
        scriptSourceChunks.delete(script);
    }
}

function addTraceEventToThread(
    diagnose: Diagnose,
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
            diagnose('warn', 'Ignoring end event without id', {
                cat: event.cat,
                name: event.name,
                pid: event.pid,
                tid: event.tid
            });
            return;
        }

        const startEvent = eventMap.get(eventId);

        if (startEvent) {
            startEvent.duration = tm - startEvent.tm;
            eventMap.delete(eventId);
            return;
        } else {
            diagnose('warn', 'Could not find start event for end event', {
                eventId,
                cat: event.cat,
                name: event.name,
                pid: event.pid,
                tid: event.tid
            });
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
            diagnose('warn', 'Ignoring begin event without id', {
                cat: event.cat,
                name: event.name,
                pid: event.pid,
                tid: event.tid
            });
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
    events: ChromiumTraceEventsSource | ChromiumTraceEventsSource['traceEvents'],
    diagnose: Diagnose = diagnoseToConsole
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
    const scriptSourceChunks: ScriptSourceChunks = new Map();

    // Metadata and source maps
    let metadata: ChromiumTraceEventsMetadata = {};
    let sourceMaps: ProfileSourceMap[] = [];
    const sourceMapByUrl = new Map<string, ProfileSourceMap>();
    const sourceMapByUrlDuplicates = new Set<string>();
    const sourceMapBySourceMapUrl = new Map<string, ProfileSourceMap>();

    // JSON Object Format
    if ('traceEvents' in events) {
        metadata = events.metadata || {};
        sourceMaps = metadata.sourceMaps || [];
        events = events.traceEvents;
    }

    // Index source maps by URL for quick lookup
    for (const sourceMap of sourceMaps) {
        if (sourceMap.sourceMapUrl) {
            sourceMapBySourceMapUrl.set(sourceMap.sourceMapUrl, sourceMap);
        }

        if (sourceMap.url && !sourceMapByUrlDuplicates.has(sourceMap.url)) {
            if (sourceMapByUrl.has(sourceMap.url)) {
                // when several source maps have the same URL, we cannot reliably resolve them, so we ignore all of them
                sourceMapByUrlDuplicates.add(sourceMap.url);
                sourceMapByUrl.delete(sourceMap.url);
            } else {
                sourceMapByUrl.set(sourceMap.url, sourceMap);
            }
        }
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
                const data = event.args.data as Partial<V8CpuProfile> & { isolate?: string };
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
                    ...data
                };
                profileById.set(threadId, profile);

                const profileData: ChromiumTraceProfileData = {
                    eventChannel,
                    pid: event.pid,
                    tid: event.tid,
                    capture: { id: event.id ?? null, isolate: data.isolate ?? null },
                    startTime: data.startTime || 0,
                    endTime: 0,
                    chunks: [],
                    samples: 0,
                    hasLineColumns: false,
                    hasAllocationsMapping: false,
                    allocationChunks: [],
                    allocationGcs: [],
                    allocationVectorProducers: new Set()
                };

                profileDataById.set(profileId, profileData);
                profileDataByTid.set(threadId, profileData);

                if (data.isolate) {
                    eventChannel.thread.isolate = data.isolate;
                    profileDataByIsolate.set(data.isolate, profileData);
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
                        sourceMap: null,
                        lineOffset: 0,
                        columnOffset: 0
                    });
                    eventChannel.thread.scripts.push(script);
                }

                for (const key of Object.keys(props)) {
                    switch (key) {
                        case 'url':
                            script[key] = props[key];
                            break;

                        case 'lineOffset':
                        case 'columnOffset':
                            script[key] = props[key];
                            break;

                        case 'sourceMapUrl':
                            script.sourceMapUrl = props.sourceMapUrl;
                            break;

                        case 'sourceText':
                            applyScriptSourceText(
                                diagnose,
                                scriptSourceChunks,
                                script,
                                event,
                                props
                            );
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
                    data: event.args
                });

                break;
            }

            case 'ProfileChunk': {
                const chunk: ChromiumTraceProfileChunkEventData = event.args.data;
                // Allocation chunks may be emitted by a different process. Their pid/id
                // identify the producer; isolate identifies the profile receiving the data.
                const profileData = chunk.isolate
                    ? profileDataByIsolate.get(chunk.isolate)
                    : profileDataById.get(`${event.pid}:${event.id}`);

                if (!profileData) {
                    diagnose('warn', 'Ignoring ProfileChunk for undeclared Profile', {
                        pid: event.pid,
                        id: event.id
                    });
                    continue;
                }

                if (chunk.allocationSamples?.ids === null) {
                    profileData.allocationVectorProducers.add(`${event.pid}:${event.tid}`);
                }

                prepareChunkVectors(chunk);
                profileData.chunks.push(chunk);
                profileData.hasLineColumns ||= isInt32Vector(chunk.lines) && isInt32Vector(chunk.columns);
                profileData.hasAllocationsMapping ||= isNumberVector(chunk.allocationSampleIds) && chunk.allocationSampleIds.length > 0;

                const { cpuProfile, allocationSamples, allocationGc, endTime } = chunk;

                if (cpuProfile) {
                    profileData.samples += cpuProfile.samples?.length ?? 0;
                }

                if (allocationSamples) {
                    profileData.allocationChunks.push(allocationSamples as DecodedAllocationSamples);
                }

                if (allocationGc) {
                    profileData.allocationGcs.push(allocationGc as DecodedAllocationGc);
                }

                if (endTime && endTime > profileData.endTime) {
                    profileData.endTime = endTime;
                }

                break;
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
                    addTraceEventToThread(diagnose, eventChannels, event, event.args.data);
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
                    addTraceEventToThread(diagnose, eventChannels, event, data, sampleTraceId);
                } else if (event.cat === 'blink.user_timing') {
                    if (event.ph === 'b' || event.ph === 'e') {
                        addTraceEventToThread(
                            diagnose,
                            eventChannels,
                            event,
                            event.args,
                            event.args?.traceId || null
                        );
                    }
                } else if (event.cat === 'disabled-by-default-v8.compile' ||
                    event.cat === 'disabled-by-default-v8.compilation_allocations' ||
                    event.ph === 'X' || event.ph === 'b' || event.ph === 'e') {
                    addTraceEventToThread(diagnose, eventChannels, event, event.args);
                }
            }
        }
    }

    for (const [script, { splitCount, chunks }] of scriptSourceChunks) {
        diagnose('warn', 'Incomplete script source chunks left after extraction', {
            scriptId: script.id,
            url: script.url,
            splitCount,
            received: chunks.size
        });
    }

    for (const { thread } of eventChannels.values()) {
        const compilations = extractCompilations(thread, diagnose);

        if (compilations.length > 0) {
            thread.compilations = compilations;
        }
    }

    const allocationVectorsByProducer = groupAllocationVectorsByProducer(metadata.allocationVectors);

    for (const profileData of profileDataById.values()) {
        const { pid, tid, eventChannel, startTime, endTime, chunks, samples } = profileData;
        let { allocationChunks, allocationGcs } = profileData;
        const { thread } = eventChannel;
        const profile: V8CpuProfile = {
            _name: thread.name,
            _pid: pid,
            _tid: tid,
            _capture: profileData.capture,
            startTime,
            endTime,
            nodes: [],
            samples: buildChunkedArray('samples', chunks, samples, Uint32Array),
            timeDeltas: buildChunkedArray('timeDeltas', chunks, samples, Int32Array),
            trace_ids: {},
            lines: undefined,
            columns: undefined
        };

        if (thread.scripts) {
            const scripts = Array.from(thread.scripts.values());

            profile._scripts = scripts;
            attachSourceMapsToScripts(scripts, sourceMapByUrl, sourceMapBySourceMapUrl);
        }

        appendCpuProfileChunks(profile, chunks);

        if (profileData.hasLineColumns) {
            profile.lines = buildChunkedArray('lines', chunks, samples, Int32Array);
            profile.columns = buildChunkedArray('columns', chunks, samples, Int32Array);
        }

        if (profileData.hasAllocationsMapping) {
            profile._cpuproAllocationMapping = buildChunkedArray('allocationSampleIds', chunks, samples, Uint32Array);
        }

        if (profileData.allocationVectorProducers.size > 0) {
            const producers = [...profileData.allocationVectorProducers];
            const vectors = allocationVectorsByProducer.get(producers[0]);

            if (producers.length > 1) {
                // the order of concatenation across producers is unknown
                diagnose('warn', 'Ignoring allocation data with metadata vectors of several producers', { pid, tid, producers });
                allocationChunks = [];
                allocationGcs = [];
            } else if (vectors === undefined) {
                diagnose('warn', 'Ignoring allocation data with vectors missing in metadata', { pid, tid, producers });
                allocationChunks = [];
                allocationGcs = [];
            } else {
                // Vectors of a producer stand for the concatenation of its chunk vectors (the chunks
                // contribute empty vectors), while dictionaries remain in the chunks
                allocationChunks = [vectors.samples, ...allocationChunks];
                allocationGcs = [vectors.gc];
            }
        }

        const ids = buildChunkedVector(allocationChunks, 'ids', Uint32Array);
        const idsOrder = ids ? getNumericArrayOrder(ids) : undefined;

        if (idsOrder === 'unordered') {
            diagnose('warn', 'Ignoring allocation data with unsorted IDs', { pid, tid });
        } else if (allocationChunks.length > 0) {
            const allocationsCount = ids ? ids.length : 0;

            profile._cpuproAllocationIds = ids;
            profile._cpuproAllocationIdsOrder = idsOrder;
            profile._cpuproAllocationSizes = buildChunkedVector(allocationChunks, 'sizes', Uint32Array, allocationsCount);
            profile._cpuproAllocationScriptIds = buildChunkedVector(allocationChunks, 'scriptIds', Int32Array, allocationsCount);
            profile._cpuproAllocationLocations = buildChunkedVector(allocationChunks, 'scriptOffsets', Int32Array, allocationsCount);
            profile._cpuproAllocationContextInfo = buildChunkedVector(allocationChunks, 'contextInfo', Uint32Array, allocationsCount);
            profile._cpuproAllocationBuiltinNames = buildChunkedMap(profile._cpuproAllocationContextInfo, allocationChunks, 'builtinsDict');
            profile._cpuproAllocationVmStateNames = buildChunkedMap(profile._cpuproAllocationContextInfo, allocationChunks, 'vmStatesDict');
            profile._cpuproAllocationTypes = buildChunkedVector(allocationChunks, 'types', Uint32Array, allocationsCount);
            profile._cpuproAllocationTypeNames = buildChunkedMap(profile._cpuproAllocationTypes, allocationChunks, 'typesDict');
            profile._cpuproAllocationSpaces = buildChunkedVector(allocationChunks, 'spaces', Uint32Array, allocationsCount);
            profile._cpuproAllocationSpaceNames = buildChunkedMap(profile._cpuproAllocationSpaces, allocationChunks, 'spacesDict');
            profile._cpuproAllocationCodeType = buildChunkedVector(allocationChunks, 'codeTypes', Uint32Array, allocationsCount);
            profile._cpuproAllocationCodeTypeNames = buildChunkedMap(profile._cpuproAllocationCodeType, allocationChunks, 'codeTypesDict');
            profile._cpuproAllocationGc = updateAllocationsGc(
                diagnose,
                ids,
                profile._cpuproAllocationIdsOrder,
                allocationGcs,
                buildChunkedVector(allocationChunks, 'gc', Uint32Array, allocationsCount)
            );
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

        profiles,

        ownership: metadata.ownership ?? null
    };
}

function extractCompilations(
    thread: UniformThread,
    diagnose: Diagnose
): UniformCompilationRecord[] {
    const source = 'disabled-by-default-v8.compilation_allocations';
    const records: UniformCompilationRecord[] = [];
    const { events } = thread;
    let isolate = thread.isolate ?? null;
    let conflictingIsolates = false;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        const event = events[eventIndex];

        if (event.cat !== source) {
            if (!event.cat.includes(source)) {
                continue;
            }

            const categories = event.cat.split(',');
            if (!categories.includes(source)) {
                continue;
            }
        }

        const data = (event.data as { data?: CompilationAllocationEventData } | null)?.data;

        if (data?.isolate) {
            if (isolate !== null && isolate !== data.isolate) {
                conflictingIsolates = true;
            }

            isolate ??= data.isolate;
        }

        // The source event has one owner. Persist its index, not a second object path;
        // runtime links are filled on processing records, never during extraction.
        records.push({
            name: event.name,
            tm: event.tm >= 0 ? event.tm : null,
            duration: event.duration >= 0 ? event.duration : null,
            scriptId: data?.scriptId ?? null,
            start: data?.start ?? null,
            end: data?.end ?? null,
            line: data?.line ?? null,
            column: data?.column ?? null,
            functionName: null,
            allocationStart: data?.startAllocationId ?? null,
            allocationEnd: data?.endAllocationId ?? null,
            eventIndex,
            event: null,
            callFrame: null
        });
    }

    // Do not invent a combined identity for inconsistent input. Source isolate values
    // remain recoverable through eventIndex, but automatic binding must remain unresolved.
    if (conflictingIsolates) {
        diagnose('warn', 'Conflicting compilation isolates for thread', {
            pid: thread.pid,
            tid: thread.tid
        });
    }

    thread.isolate = conflictingIsolates ? null : isolate;

    return records;
}

function groupAllocationVectorsByProducer(entries: AllocationVectorEntry[] = []) {
    const namedVectorsByProducer = new Map<string, Map<string, AllocationVectorEntry['data']>>();
    const vectorsByProducer = new Map<string, { samples: DecodedAllocationSamples; gc: DecodedAllocationGc }>();

    for (const { pid, tid, name, data } of entries) {
        const producer = `${pid}:${tid}`;
        let namedVectors = namedVectorsByProducer.get(producer);

        if (namedVectors === undefined) {
            namedVectorsByProducer.set(producer, namedVectors = new Map());
        }

        namedVectors.set(name, data);
    }

    for (const [producer, namedVectors] of namedVectorsByProducer) {
        const samples: DecodedAllocationSamples = {};
        const gc: DecodedAllocationGc = {};

        for (const key of ['ids', ...unsignedAllocationKeys] as const) {
            const data = namedVectors.get(`allocationSamples.${key}`);

            if (data !== undefined) {
                samples[key] = decodeChunkVector(data, Uint32Array);
            }
        }

        for (const key of signedAllocationKeys) {
            const data = namedVectors.get(`allocationSamples.${key}`);

            if (data !== undefined) {
                samples[key] = decodeChunkVector(data, Int32Array);
            }
        }

        for (const [name, data] of namedVectors) {
            if (name.startsWith('allocationGc.')) {
                gc[name.slice('allocationGc.'.length)] = decodeChunkVector(data, Uint32Array);
            }
        }

        vectorsByProducer.set(producer, { samples, gc });
    }

    return vectorsByProducer;
}

function appendCpuProfileChunks(profile: V8CpuProfile, chunks: ChromiumTraceProfileChunkEventData[]) {
    for (const { cpuProfile } of chunks) {
        if (cpuProfile?.nodes) {
            (profile.nodes as unknown[]).push(...cpuProfile.nodes);
        }

        if (cpuProfile?.trace_ids) {
            Object.assign(profile.trace_ids!, cpuProfile.trace_ids);
        }
    }
}

function attachSourceMapsToScripts(
    scripts: V8CpuProfileScript[],
    sourceMapByUrl: Map<string, ProfileSourceMap>,
    sourceMapBySourceMapUrl: Map<string, ProfileSourceMap>
) {
    for (const script of scripts) {
        const { sourceMapUrl, url: scriptUrl } = script;
        let sourceMap: ProfileSourceMap | null = sourceMapUrl
            ? sourceMapBySourceMapUrl.get(sourceMapUrl) ?? null
            : null;

        if (sourceMap === null && sourceMapUrl) {
            const absoluteSourceMapUrl = URL.parse(sourceMapUrl, scriptUrl || undefined);

            if (absoluteSourceMapUrl) {
                sourceMap = sourceMapBySourceMapUrl.get(absoluteSourceMapUrl.toString()) ?? null;
            }
        }

        if (sourceMap === null && scriptUrl) {
            sourceMap = sourceMapByUrl.get(scriptUrl) ?? null;
        }

        if (sourceMap) {
            script.sourceMap = sourceMap.sourceMap;
        }
    }
}

function prepareChunkVectors(chunk: ChromiumTraceProfileChunkEventData) {
    if (chunk.cpuProfile && isUint32Vector(chunk.cpuProfile.samples)) {
        chunk.cpuProfile.samples = decodeChunkVector(chunk.cpuProfile.samples, Uint32Array);
    }

    if (isNumberVector(chunk.timeDeltas) || isInt32Vector(chunk.timeDeltas)) {
        chunk.timeDeltas = decodeChunkVector(chunk.timeDeltas, Int32Array);
    }

    if (isNumberVector(chunk.allocationSampleIds) || chunk.allocationSampleIds instanceof Int32Array) {
        chunk.allocationSampleIds = decodeChunkVector(chunk.allocationSampleIds, Uint32Array);
    }

    for (const key of ['lines', 'columns'] as const) {
        const value = chunk[key];

        if (isInt32Vector(value)) {
            chunk[key] = decodeChunkVector(value, Int32Array);
        }
    }

    const { allocationSamples, allocationGc } = chunk;

    if (allocationSamples) {
        if (allocationSamples.ids !== undefined) {
            allocationSamples.ids = decodeChunkVector(allocationSamples.ids, Uint32Array);
        }

        for (const key of signedAllocationKeys) {
            const value = allocationSamples[key];

            if (value !== undefined) {
                allocationSamples[key] = decodeChunkVector(value, Int32Array);
            }
        }

        for (const key of unsignedAllocationKeys) {
            const value = allocationSamples[key];

            if (value !== undefined) {
                allocationSamples[key] = decodeChunkVector(value, Uint32Array);
            }
        }
    }

    if (allocationGc) {
        for (const key of Object.keys(allocationGc)) {
            allocationGc[key] = decodeChunkVector(allocationGc[key], Uint32Array);
        }
    }
}

function decodeChunkVector<Vector extends Int32Array | Uint32Array>(
    source: number[] | Int32Array | Uint32Array | Float64Array | string,
    VectorType: {
        new(values: number[] | Int32Array | Uint32Array | Float64Array): Vector;
        new(buffer: ArrayBufferLike, byteOffset: number, length: number): Vector;
    }
): Vector {
    if (typeof source === 'string') {
        return new VectorType(JSON.parse(source));
    }

    if (source instanceof VectorType) {
        return source;
    }

    // Converting Int32 values to Uint32 and back is a reinterpretation of their bits,
    // so a typed 32-bit integer vector (e.g. decoded by jsonxl) is viewed instead of copied
    if (source instanceof Int32Array || source instanceof Uint32Array) {
        return new VectorType(source.buffer, source.byteOffset, source.length);
    }

    return new VectorType(source);
}

function buildChunkedVector<Vector extends Int32Array | Uint32Array | Float64Array>(
    chunks: DecodedAllocationSamples[],
    key: 'ids' | typeof signedAllocationKeys[number] | typeof unsignedAllocationKeys[number],
    VectorType: { new(length: number): Vector },
    totalLength: number = 0
): Vector | undefined {
    if (!chunks.length || chunks[0][key] === undefined) {
        return undefined;
    }

    // A vector supplied whole by a single chunk (e.g. by jsonxl) is adopted instead of copied
    let wholeVector: DecodedAllocationSamples[typeof key] = undefined;
    let nonEmptyChunks = 0;

    for (const chunk of chunks) {
        const values = chunk[key];

        if (values === undefined) {
            throw new TypeError(`Missing allocation vector ${key} in ProfileChunk`);
        }

        if (values.length > 0) {
            wholeVector = values;
            nonEmptyChunks++;
        }
    }

    if (nonEmptyChunks === 1 &&
        wholeVector instanceof VectorType &&
        (totalLength === 0 || wholeVector.length === totalLength)) {
        return wholeVector;
    }

    if (totalLength === 0) {
        for (const chunk of chunks) {
            totalLength += chunk[key]!.length;
        }
    }

    const vector = new VectorType(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        const values = chunk[key]!;

        vector.set(values, offset);
        offset += values.length;
    }

    return vector.length ? vector : undefined;
}

function buildChunkedMap(
    vector: Uint32Array | undefined,
    chunks: DecodedAllocationSamples[],
    key: 'typesDict' | 'spacesDict' | 'builtinsDict' | 'vmStatesDict' | 'codeTypesDict'
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

function buildChunkedArray<Vector extends Int32Array | Uint32Array | Float64Array>(
    key: 'samples' | 'timeDeltas' | 'lines' | 'columns' | 'allocationSampleIds',
    chunks: ChromiumTraceProfileChunkEventData[],
    totalLength: number,
    VectorType: { new(length: number): Vector }
): Vector {
    const result = new VectorType(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        const array = key === 'samples'
            ? chunk.cpuProfile?.[key]
            : chunk[key];

        if (isNumberVector(array) || array instanceof Int32Array) {
            result.set(array, offset);
            offset += array.length;
        } else if (chunk.timeDeltas) {
            offset += chunk.timeDeltas.length;
        }
    }

    return result;
}

function updateAllocationsGc(
    diagnose: Diagnose,
    allocationIds: Float64Array | Uint32Array | undefined,
    allocationIdsOrder: V8CpuProfile['_cpuproAllocationIdsOrder'],
    allocationGcChunks: DecodedAllocationGc[],
    allocationGcs: Uint32Array | undefined
): Uint32Array | undefined {
    if (!allocationGcChunks.length || !allocationIds) {
        return allocationGcs;
    }

    if (!allocationGcs) {
        allocationGcs = new Uint32Array(allocationIds.length);
    }

    // Consecutive ids let us calculate the GC array index directly from the id.
    // Otherwise a map is needed (historically measured to be about 3x slower).
    if (allocationIdsOrder === 'consecutive') {
        const firstId = allocationIds[0];
        const lastId = allocationIds[allocationIds.length - 1];

        for (const allocationGc of allocationGcChunks) {
            for (const [key, gcIds] of Object.entries(allocationGc)) {
                const gc = parseInt(key);

                for (let i = 0; i < gcIds.length; i++) {
                    const id = gcIds[i];
                    if (id >= firstId && id <= lastId) {
                        allocationGcs[id - firstId] = gc;
                    }
                }
            }
        }
    } else {
        for (let index = 1; index < allocationIds.length; index++) {
            if (allocationIds[index] !== allocationIds[index - 1] + 1) {
                const indexNextExpected = allocationIds.indexOf(allocationIds[index - 1] + 1, index);

                diagnose('warn', 'Allocation ids are not consecutive, GC mapping will be slower', {
                    index,
                    id: allocationIds[index - 1],
                    nextId: allocationIds[index],
                    nextIndex: indexNextExpected,
                    length: allocationIds.length,
                    lastId: allocationIds[allocationIds.length - 1]
                });
                break;
            }
        }

        const idToIndexMap = new Map<number, number>();

        for (let index = 0; index < allocationIds.length; index++) {
            idToIndexMap.set(allocationIds[index], index);
        }

        for (const allocationGc of allocationGcChunks) {
            for (const [key, gcIds] of Object.entries(allocationGc)) {
                const gc = parseInt(key);

                for (let i = 0; i < gcIds.length; i++) {
                    const index = idToIndexMap.get(gcIds[i]);
                    if (index !== undefined) {
                        allocationGcs[index] = gc;
                    }
                }
            }
        }
    }

    return allocationGcs;
}
