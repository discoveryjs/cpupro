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
    AllocationIdsByGc,
    AllocationIdVector,
    ColumnNumberVector,
    LineNumberVector,
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
    data: TraceVector;
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
// A vector of a trace is decoded into the 32-bit integer vector of its values whatever its form: a decoder
// (e.g. jsonxl) chooses a typed array by the range of the values, regardless of whether they are signed
type TraceVector = number[] | Int32Array | Uint32Array | Float64Array;
// Each ProfileChunk holds a segment of the capture's allocation vectors, encoded as an array
// of numbers or as JSON.stringify(numbers). The jsonxl layout holds null instead and stores
// whole vectors in trace metadata (see AllocationVectorEntry).
type AllocationSamples = {
    ids?: TraceVector | string | null;
    sizes?: TraceVector | string | null;
    scriptIds?: TraceVector | string | null;
    scriptOffsets?: TraceVector | string | null;
    contextInfo?: TraceVector | string | null; // vm state + builtin id
    builtinsDict?: Record<number, string>;
    vmStatesDict?: Record<number, string>;
    types?: TraceVector | string | null;
    typesDict?: Record<string, string>;
    spaces?: TraceVector | string | null;
    spacesDict?: Record<string, string>;
    codeTypes?: TraceVector | string | null;
    codeTypesDict?: Record<string, string>;
    gc?: TraceVector | string | null;
};
// Allocation ids per GC (the key)
type AllocationGc = {
    [key: string]: TraceVector | string | null;
};
type AllocationSampleVectors = {
    ids?: Uint32Array;
    sizes?: Uint32Array;
    scriptIds?: Uint32Array;
    scriptOffsets?: Int32Array;
    contextInfo?: Uint32Array;
    types?: Uint32Array;
    spaces?: Uint32Array;
    codeTypes?: Uint32Array;
    gc?: Uint32Array;
};
const signedAllocationKeys = ['scriptOffsets'] as const;
const unsignedAllocationKeys = ['sizes', 'scriptIds', 'contextInfo', 'types', 'spaces', 'codeTypes', 'gc'] as const;
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
    allocationSampleIds?: AllocationIdVector | Int32Array;
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
    // allocation samples of chunks, for their dictionaries
    allocationChunks: AllocationSamples[];
    // decoded vector segments of chunks, in chunk order
    allocationSegments: AllocationSampleVectors[];
    allocationGcs: AllocationIdsByGc[];
    // producers of chunks whose allocation vectors are stored in metadata (jsonxl)
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

// Event channels by the pid and tid of their thread, in the order of creation
class EventChannels {
    #channels: EventChannel[] = [];
    #channelsByPid = new Map<number, Map<number, EventChannel>>();
    #lastChannel: EventChannel | null = null;

    values() {
        return this.#channels;
    }

    getOrCreate(event: { pid: number; tid: number }): EventChannel {
        const { pid, tid } = event;
        const lastChannel = this.#lastChannel;

        // PERF: Events of a thread come in runs, so the channel of the previous event is checked before a lookup
        if (lastChannel !== null && lastChannel.thread.tid === tid && lastChannel.thread.pid === pid) {
            return lastChannel;
        }

        let channelsByTid = this.#channelsByPid.get(pid);

        if (channelsByTid === undefined) {
            channelsByTid = new Map();
            this.#channelsByPid.set(pid, channelsByTid);
        }

        let eventChannel = channelsByTid.get(tid);

        if (eventChannel === undefined) {
            const events: UniformTraceEvent[] = [];
            const userTimings: UniformTraceEvent[] = [];

            eventChannel = {
                thread: {
                    pid,
                    tid,
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
            };
            channelsByTid.set(tid, eventChannel);
            this.#channels.push(eventChannel);
        }

        this.#lastChannel = eventChannel;

        return eventChannel;
    }
}

function getEventId(event: ChromiumTraceEvent, ph: string): string | number | null {
    if (ph === 'b' || ph === 'e') {
        const id = event.id ?? event.id2?.local ?? null;
        return id !== null ? `${event.name}:${id}` : null;
    }

    if (ph === 's' || ph === 'f') {
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
    eventChannels: EventChannels,
    event: ChromiumTraceEvent,
    ph: string, // ph and cat of the event, read once by the caller
    cat: string,
    data: unknown,
    sampleTraceId: number | null = null
) {
    const thread = eventChannels.getOrCreate(event);
    const name = event.name;
    const traceEvent: UniformTraceEvent = {
        name,
        cat,
        tm: event.ts,
        duration: event.dur || 0,
        eventId: null,
        sampleTraceId,
        data
    };
    // traceEvent.event = event;

    // PERF: Most events are complete ones, which pair with no other event, so only the begin and end events
    // take an id to be paired
    if (ph === 'b' || ph === 'e' || ph === 's' || ph === 'f') {
        const eventId = getEventId(event, ph);
        const eventMap = ph === 'b' || ph === 'e'
            ? thread.traceEventsBE
            : thread.traceEventsSF;

        if (ph === 'e' || ph === 'f') {
            if (eventId === null) {
                diagnose('warn', 'Ignoring end event without id', {
                    cat,
                    name,
                    pid: event.pid,
                    tid: event.tid
                });
                return;
            }

            const startEvent = eventMap.get(eventId);

            if (startEvent) {
                startEvent.duration = traceEvent.tm - startEvent.tm;
                eventMap.delete(eventId);
                return;
            } else {
                diagnose('warn', 'Could not find start event for end event', {
                    eventId,
                    cat,
                    name,
                    pid: event.pid,
                    tid: event.tid
                });
                traceEvent.duration = traceEvent.tm;
                traceEvent.tm = -1;
            }
        } else {
            if (eventId === null) {
                diagnose('warn', 'Ignoring begin event without id', {
                    cat,
                    name,
                    pid: event.pid,
                    tid: event.tid
                });
                return;
            }

            eventMap.set(eventId, traceEvent);
            traceEvent.duration = -1;
        }

        traceEvent.eventId = eventId;
    }

    if (cat === 'blink.user_timing') {
        thread.userTimings.push(traceEvent);
    } else {
        thread.events.push(traceEvent);
    }
}

export function extractFromChromiumPerformanceProfile(
    events: ChromiumTraceEventsSource | ChromiumTraceEventsSource['traceEvents'],
    diagnose: Diagnose = diagnoseToConsole
): UniformProfilingSession {
    const profileDataByTid = new Map<string, ChromiumTraceProfileData>();
    const profileDataById = new Map<string, ChromiumTraceProfileData>();
    const profileDataByIsolate = new Map<string, ChromiumTraceProfileData>();
    const profiles: V8CpuProfile[] = [];

    // Maps pid/tid pairs to thread names
    const processesMap = new Map<number, UniformProcess>();
    const eventChannels = new EventChannels();
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
                // a profile of a single CpuProfile event (an earlier trace layout) is not extracted
                break;
            }

            case 'Profile': {
                const data = event.args.data as Partial<V8CpuProfile> & { isolate?: string };
                const profileId = `${event.pid}:${event.id}`;
                const eventChannel = eventChannels.getOrCreate(event);
                const threadId = getEventThreadId(event);
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
                    allocationSegments: [],
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
                eventChannels.getOrCreate(event).thread.name = event.args.name;
                break;
            }

            case 'process_name': {
                getOrCreateProcess(event, processesMap).name = event.args.name;
                break;
            }

            case 'ScriptCatchup':
            case 'LargeScriptCatchup': {
                const eventChannel = eventChannels.getOrCreate(event);
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
                eventChannels.getOrCreate(event).events.push({
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

                prepareChunkVectors(chunk);
                profileData.chunks.push(chunk);
                profileData.hasLineColumns ||= isInt32Vector(chunk.lines) && isInt32Vector(chunk.columns);
                profileData.hasAllocationsMapping ||= isNumberVector(chunk.allocationSampleIds) && chunk.allocationSampleIds.length > 0;

                const { cpuProfile, allocationSamples, allocationGc, endTime } = chunk;

                if (cpuProfile) {
                    profileData.samples += cpuProfile.samples?.length ?? 0;
                }

                if (allocationSamples?.ids === null || (allocationGc && Object.values(allocationGc).includes(null))) {
                    // jsonxl: the chunk's vectors are in metadata, the chunk supplies dictionaries only
                    profileData.allocationVectorProducers.add(`${event.pid}:${event.tid}`);
                } else {
                    // decoding replaces the encoded vectors in the trace, which releases JSON strings early
                    if (allocationSamples) {
                        profileData.allocationSegments.push(decodeAllocationSamples(allocationSamples));
                    }

                    if (allocationGc) {
                        profileData.allocationGcs.push(decodeAllocationGc(allocationGc));
                    }
                }

                if (allocationSamples) {
                    profileData.allocationChunks.push(allocationSamples);
                }

                if (endTime && endTime > profileData.endTime) {
                    profileData.endTime = endTime;
                }

                break;
            }

            default: {
                // PERF: Events of a trace take many shapes, which makes every read of their fields a megamorphic
                // lookup, so each field is read once, for addTraceEventToThread() as well
                const { ph, cat, args } = event;
                let sampleTraceId: number | null = null;
                let data: unknown = null;

                // flow events (s/f) are not used
                if (ph === 's' || ph === 'f') {
                    continue;
                }

                if (cat === 'disabled-by-default-devtools.timeline' &&
                    event.name === 'UpdateCounters') {
                    addTraceEventToThread(diagnose, eventChannels, event, ph, cat, args.data);
                    break;
                }

                // PERF: Compilation events of V8 take no sample trace id, which the inspector of Blink gives to its
                // events, so their args aren't searched for one; the args of an event take several lookups of many
                // shapes, and compilation events are about half of the events of a trace that records them
                if (cat === 'disabled-by-default-v8.compile' ||
                    cat === 'disabled-by-default-v8.compilation_allocations') {
                    addTraceEventToThread(diagnose, eventChannels, event, ph, cat, args);
                    break;
                }

                if ('sampleTraceId' in args) {
                    sampleTraceId = args.sampleTraceId;
                    data = args;
                } else if (typeof args.data?.sampleTraceId === 'number') {
                    sampleTraceId = args.data.sampleTraceId;
                    data = args.data;
                } else if (typeof args.beginData?.sampleTraceId === 'number') {
                    sampleTraceId = args.beginData.sampleTraceId;
                    data = args.beginData;
                }

                if (sampleTraceId !== null) {
                    addTraceEventToThread(diagnose, eventChannels, event, ph, cat, data, sampleTraceId);
                } else if (cat === 'blink.user_timing') {
                    if (ph === 'b' || ph === 'e') {
                        addTraceEventToThread(
                            diagnose,
                            eventChannels,
                            event,
                            ph,
                            cat,
                            args,
                            args?.traceId || null
                        );
                    }
                } else if (ph === 'X' || ph === 'b' || ph === 'e') {
                    addTraceEventToThread(diagnose, eventChannels, event, ph, cat, args);
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
        const { pid, tid, eventChannel, startTime, endTime, chunks, samples, allocationChunks } = profileData;
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

        // Allocation vectors of the capture are either stored whole in metadata by their producer (jsonxl)
        // or concatenated from the segments of the chunks
        let allocationVectors: AllocationSampleVectors | null = null;
        let allocationGcs = profileData.allocationGcs;

        if (profileData.allocationVectorProducers.size > 0) {
            const producers = [...profileData.allocationVectorProducers];
            const stored = allocationVectorsByProducer.get(producers[0]);

            if (producers.length > 1) {
                // the order of concatenation across producers is unknown
                diagnose('warn', 'Ignoring allocation data with metadata vectors of several producers', { pid, tid, producers });
            } else if (stored === undefined) {
                diagnose('warn', 'Ignoring allocation data with vectors missing in metadata', { pid, tid, producers });
            } else {
                allocationVectors = stored.vectors;
                allocationGcs = [stored.gc];
            }
        } else if (allocationChunks.length > 0) {
            allocationVectors = concatAllocationSegments(profileData.allocationSegments, diagnose);
        }

        if (allocationVectors !== null) {
            const { ids } = allocationVectors;
            const idsOrder = ids ? getNumericArrayOrder(ids) : undefined;

            if (idsOrder === 'unordered') {
                diagnose('warn', 'Ignoring allocation data with unsorted IDs', { pid, tid });
            } else {
                profile._cpuproAllocationIds = ids;
                profile._cpuproAllocationIdsOrder = idsOrder;
                profile._cpuproAllocationSizes = allocationVectors.sizes;
                profile._cpuproAllocationScriptIds = allocationVectors.scriptIds;
                profile._cpuproAllocationLocations = allocationVectors.scriptOffsets;
                profile._cpuproAllocationContextInfo = allocationVectors.contextInfo;
                profile._cpuproAllocationBuiltinNames = buildChunkedMap(allocationVectors.contextInfo, allocationChunks, 'builtinsDict');
                profile._cpuproAllocationVmStateNames = buildChunkedMap(allocationVectors.contextInfo, allocationChunks, 'vmStatesDict');
                profile._cpuproAllocationTypes = allocationVectors.types;
                profile._cpuproAllocationTypeNames = buildChunkedMap(allocationVectors.types, allocationChunks, 'typesDict');
                profile._cpuproAllocationSpaces = allocationVectors.spaces;
                profile._cpuproAllocationSpaceNames = buildChunkedMap(allocationVectors.spaces, allocationChunks, 'spacesDict');
                profile._cpuproAllocationCodeType = allocationVectors.codeTypes;
                profile._cpuproAllocationCodeTypeNames = buildChunkedMap(allocationVectors.codeTypes, allocationChunks, 'codeTypesDict');
                profile._cpuproAllocationGc = allocationVectors.gc;
                profile._cpuproAllocationGcIds = updateAllocationsGc(
                    diagnose,
                    ids,
                    idsOrder,
                    allocationGcs,
                    allocationVectors.gc
                );
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
        threads: eventChannels.values()
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

// Metadata vectors of a producer have the form of a single chunk holding whole vectors
function groupAllocationVectorsByProducer(entries: AllocationVectorEntry[] = []) {
    const encodedByProducer = new Map<string, { samples: Record<string, unknown>; gc: AllocationGc }>();
    const decodedByProducer = new Map<string, { vectors: AllocationSampleVectors; gc: AllocationIdsByGc }>();

    for (const { pid, tid, name, data } of entries) {
        const producer = `${pid}:${tid}`;
        let encoded = encodedByProducer.get(producer);

        if (encoded === undefined) {
            encodedByProducer.set(producer, encoded = { samples: {}, gc: {} });
        }

        if (name.startsWith('allocationSamples.')) {
            encoded.samples[name.slice('allocationSamples.'.length)] = data;
        } else if (name.startsWith('allocationGc.')) {
            encoded.gc[name.slice('allocationGc.'.length)] = data;
        }
    }

    for (const [producer, { samples, gc }] of encodedByProducer) {
        decodedByProducer.set(producer, {
            vectors: decodeAllocationSamples(samples as AllocationSamples),
            gc: decodeAllocationGc(gc)
        });
    }

    return decodedByProducer;
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
}

// Decodes allocation sample vectors in place and returns them;
// it's not applied to jsonxl chunks, whose vectors are null
function decodeAllocationSamples(allocationSamples: AllocationSamples): AllocationSampleVectors {
    if (allocationSamples.ids !== undefined) {
        allocationSamples.ids = decodeChunkVector(allocationSamples.ids!, Uint32Array);
    }

    for (const key of signedAllocationKeys) {
        const value = allocationSamples[key];

        if (value !== undefined) {
            allocationSamples[key] = decodeChunkVector(value!, Int32Array);
        }
    }

    for (const key of unsignedAllocationKeys) {
        const value = allocationSamples[key];

        if (value !== undefined) {
            allocationSamples[key] = decodeChunkVector(value!, Uint32Array);
        }
    }

    return allocationSamples as AllocationSampleVectors;
}

// Decodes allocation ids per GC in place and returns them
function decodeAllocationGc(allocationGc: AllocationGc): AllocationIdsByGc {
    for (const key of Object.keys(allocationGc)) {
        allocationGc[key] = decodeChunkVector(allocationGc[key]!, Uint32Array);
    }

    return allocationGc as AllocationIdsByGc;
}

function decodeChunkVector<Vector extends Int32Array | Uint32Array>(
    source: TraceVector | string,
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

// Concatenates the vector segments of chunks, in chunk order, into the capture's vectors
function concatAllocationSegments(segments: AllocationSampleVectors[], diagnose: Diagnose): AllocationSampleVectors {
    return {
        ids: concatSegments(segments, 'ids', Uint32Array, diagnose),
        sizes: concatSegments(segments, 'sizes', Uint32Array, diagnose),
        scriptIds: concatSegments(segments, 'scriptIds', Uint32Array, diagnose),
        scriptOffsets: concatSegments(segments, 'scriptOffsets', Int32Array, diagnose),
        contextInfo: concatSegments(segments, 'contextInfo', Uint32Array, diagnose),
        types: concatSegments(segments, 'types', Uint32Array, diagnose),
        spaces: concatSegments(segments, 'spaces', Uint32Array, diagnose),
        codeTypes: concatSegments(segments, 'codeTypes', Uint32Array, diagnose),
        gc: concatSegments(segments, 'gc', Uint32Array, diagnose)
    };
}

// A vector is taken when every chunk has its segment: a vector absent in all chunks isn't recorded,
// and a vector absent in some of them can't be aligned with the rows of the other vectors
function concatSegments<Vector extends Int32Array | Uint32Array>(
    segments: AllocationSampleVectors[],
    key: keyof AllocationSampleVectors,
    VectorType: { new(length: number): Vector },
    diagnose: Diagnose
): Vector | undefined {
    let missingSegments = 0;
    let length = 0;

    for (let i = 0; i < segments.length; i++) {
        const values = segments[i][key];

        if (values === undefined) {
            missingSegments++;
        } else {
            length += values.length;
        }
    }

    if (missingSegments > 0 && missingSegments < segments.length) {
        diagnose('warn', 'Ignoring an allocation vector missing in some ProfileChunk events', {
            vector: key,
            missingChunks: missingSegments,
            chunks: segments.length
        });

        return undefined;
    }

    if (length === 0) {
        return undefined;
    }

    const vector = new VectorType(length);
    let offset = 0;

    for (const segment of segments) {
        const values = segment[key]!;

        vector.set(values, offset);
        offset += values.length;
    }

    return vector;
}

function buildChunkedMap(
    vector: Uint32Array | undefined,
    chunks: AllocationSamples[],
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

// GC of allocations comes as lists of allocation ids by GC value. The lists are written into the GC vector
// of allocations when chunks have one, otherwise they are given as they are, and consumers take the GC
// of allocations from them without a vector of a value per allocation
function updateAllocationsGc(
    diagnose: Diagnose,
    allocationIds: Float64Array | Uint32Array | undefined,
    allocationIdsOrder: V8CpuProfile['_cpuproAllocationIdsOrder'],
    allocationGcChunks: AllocationIdsByGc[],
    allocationGcs: Uint32Array | undefined
): AllocationIdsByGc[] | undefined {
    if (!allocationGcChunks.length || !allocationIds) {
        return undefined;
    }

    if (allocationIdsOrder !== 'consecutive') {
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
    }

    if (!allocationGcs) {
        return allocationGcChunks;
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

    return undefined;
}
