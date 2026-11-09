import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { extractFromChromiumPerformanceProfile, isChromiumPerformanceProfile } from './chromium-performance-profile.js';
import { isCPUProfile } from './cpuprofile.js';
import { createDiagnosticsCollector, type Diagnose } from '../diagnostics.js';
import { collectProfileUsedScriptIds } from '../preprocessing/scripts.js';
import { Dictionary } from '../dictionary.js';
import { createProfileSession } from '../profile-session.mjs';
import { createProfile } from '../profile.mjs';
import type { V8CpuProfile } from '../types.js';
import type { UniformProfilingSession } from './types.js';

const capture = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };

// A single CPU capture: its Profile declaration followed by ProfileChunk payloads in trace order
function captureEvents(chunks: object[]) {
    return [
        { ...capture, name: 'Profile', args: { data: { startTime: 0 } } },
        ...chunks.map(data => ({ ...capture, name: 'ProfileChunk', args: { data } }))
    ];
}

function publishedAllocations(profile: V8CpuProfile) {
    return Object.fromEntries(Object.entries(profile).filter(([key, value]) =>
        key.startsWith('_cpuproAllocation') && value !== undefined
    ));
}

function diagnosticEntries(diagnostics: ReturnType<typeof createDiagnosticsCollector>['diagnostics']) {
    return diagnostics.map(({ message, details }) => [message, details]);
}

test.each([
    { input: 'an empty event array', data: [], expected: true },
    { input: 'an event array', data: [{ pid: 1, tid: 2, ph: 'X', cat: 'v8' }], expected: true },
    { input: 'JSON object format', data: { traceEvents: [{ pid: 1, tid: 2, ph: 'X', cat: 'v8' }] }, expected: true },
    { input: 'JSON object format without events', data: { traceEvents: [] }, expected: true },
    { input: 'JSON object format of other entries', data: { traceEvents: [{ nodes: [] }] }, expected: false },
    { input: 'an event without pid', data: [{ tid: 2, ph: 'X', cat: 'v8' }], expected: false },
    { input: 'an event without tid', data: [{ pid: 1, ph: 'X', cat: 'v8' }], expected: false },
    { input: 'an event without ph', data: [{ pid: 1, tid: 2, cat: 'v8' }], expected: false },
    { input: 'an event without cat', data: [{ pid: 1, tid: 2, ph: 'X' }], expected: false },
    { input: 'an array of CPU profiles', data: [{ nodes: [], samples: [], timeDeltas: [] }], expected: false },
    { input: 'a CPU profile', data: { nodes: [], samples: [], timeDeltas: [] }, expected: false },
    { input: 'null', data: null, expected: false },
    { input: 'a string', data: 'traceEvents', expected: false }
])('detects Chromium trace events in $input: $expected', ({ data, expected }) => {
    assert.equal(isChromiumPerformanceProfile(data), expected);
});

test.each([
    {
        input: 'without metadata',
        metadata: undefined,
        expected: { startTime: null, source: null, dataOrigin: null, ownership: null }
    },
    {
        input: 'with metadata',
        metadata: {
            startTime: '2026-11-06T10:00:00.000Z',
            source: 'DevTools',
            dataOrigin: 'TraceEvents',
            ownership: { api: 'ownership', areas: ['app'], files: { 'app.js': [0] } }
        },
        expected: {
            startTime: '2026-11-06T10:00:00.000Z',
            source: 'DevTools',
            dataOrigin: 'TraceEvents',
            ownership: { api: 'ownership', areas: ['app'], files: { 'app.js': [0] } }
        }
    }
])('JSON object format publishes session metadata: $input', ({ metadata, expected }) => {
    const session = extractFromChromiumPerformanceProfile({ traceEvents: captureEvents([]), metadata });

    assert.deepEqual({
        startTime: session.startTime,
        source: session.source,
        dataOrigin: session.dataOrigin,
        ownership: session.ownership
    }, expected);
    assert.equal(session.profiles.length, 1);
});

test('records only complete, paired, sampled and compile events in thread events', () => {
    const counters = { jsHeapSizeUsed: 100 };
    const event = { pid: 1, tid: 2, cat: 'toplevel', args: {} };
    const timeline = 'disabled-by-default-devtools.timeline';
    const compile = 'disabled-by-default-v8.compile';
    const userTiming = { ...event, cat: 'blink.user_timing' };
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile([
        { ...event, name: 'Task', ph: 'X', ts: 1, dur: 5, id: 'task' },
        { ...event, name: 'Instant', ph: 'I', ts: 2 },
        { ...event, name: 'Async', ph: 'b', ts: 3, id: 7 },
        { ...event, name: 'CompileInstant', cat: compile, ph: 'I', ts: 4 },
        { ...event, name: 'UpdateCounters', cat: timeline, ph: 'I', ts: 5, args: { data: counters } },
        { ...event, name: 'Paint', cat: timeline, ph: 'I', ts: 6, args: { data: {} } },
        { ...event, name: 'Flow', cat: compile, ph: 's', ts: 7, id: 9 },
        { ...event, name: 'Async', ph: 'e', ts: 8, id: 7 },
        { ...event, name: 'Flow', cat: compile, ph: 'f', ts: 9, id: 9 },
        { ...event, name: 'FunctionCall', ph: 'I', ts: 10, args: { data: { sampleTraceId: 42 } } },
        { ...userTiming, name: 'Measure', ph: 'b', ts: 11, id: 'm', args: { traceId: 3 } },
        { ...userTiming, name: 'Mark', ph: 'R', ts: 12, args: { traceId: 4 } },
        { ...userTiming, name: 'Measure', ph: 'e', ts: 15, id: 'm', args: { traceId: 3 } }
    ], diagnose);
    const thread = session.threads[0];

    assert.deepEqual(thread.events.map(({ name, tm, duration, eventId, sampleTraceId }) => [name, tm, duration, eventId, sampleTraceId]), [
        ['Task', 1, 5, null, null],
        ['Async', 3, 5, 'Async:7', null],
        ['CompileInstant', 4, 0, null, null],
        ['UpdateCounters', 5, 0, null, null],
        ['FunctionCall', 10, 0, null, 42]
    ]);
    assert.equal(thread.events[3].data, counters);
    assert.deepEqual(thread.userTimings.map(({ name, tm, duration, eventId, sampleTraceId }) => [name, tm, duration, eventId, sampleTraceId]), [
        ['Measure', 11, 4, 'Measure:m', 3]
    ]);
    assert.deepEqual(diagnostics, []);
});

test('threads are ordered by process and thread id regardless of first appearance', () => {
    const metadata = { ts: 0, ph: 'M', cat: '__metadata' };
    const session = extractFromChromiumPerformanceProfile([
        { ...metadata, name: 'thread_name', pid: 2, tid: 1, args: { name: 'worker' } },
        { ...metadata, name: 'thread_name', pid: 1, tid: 3, args: { name: 'second' } },
        { ...metadata, name: 'thread_name', pid: 1, tid: 2, args: { name: 'main' } },
        { ...metadata, name: 'process_name', pid: 1, tid: 2, args: { name: 'Renderer' } }
    ]);

    assert.deepEqual(session.threads.map(({ pid, tid, name }) => [pid, tid, name]), [
        [1, 2, 'main'],
        [1, 3, 'second'],
        [2, 1, 'worker']
    ]);
    assert.deepEqual(session.processes, [{ pid: 1, name: 'Renderer' }]);
});

test('accepts event-only and empty traces without requiring a CPU capture', () => {
    const session = extractFromChromiumPerformanceProfile([{
        pid: 1, tid: 2, ts: 100, dur: 20, ph: 'X',
        cat: 'disabled-by-default-v8.compilation_allocations',
        name: 'Compile', args: { data: {} }
    }]);

    assert.equal(session.profiles.length, 0);
    assert.equal(session.threads[0].compilations?.length, 1);
    assert.equal(session.threads[0].compilations?.[0].name, 'Compile');
    assert.equal(extractFromChromiumPerformanceProfile([]).profiles.length, 0);
});

test('preserves instant and complete compilation allocation events with their function identity', () => {
    const category = 'disabled-by-default-v8.compilation_allocations';
    const base = { pid: 1, tid: 2, ts: 0, cat: category };
    const data = {
        column: 3097,
        end: 3635,
        endAllocationId: 8454,
        isolate: '8840219451173638266',
        line: 0,
        scriptId: 5,
        start: 3097,
        startAllocationId: 8448
    };
    const instantArgs = { data: { ...data, startAllocationId: data.endAllocationId } };
    const completeArgs = { data };
    const traceEvents = [
        { ...base, name: 'Profile', ph: 'P', id: '1', args: { data: { startTime: 0 } } },
        { ...base, name: 'CompileFunction', ph: 'I', ts: 20, args: instantArgs },
        { ...base, name: 'CompileCode', ph: 'X', ts: 10, dur: 15, args: completeArgs },
        { ...base, name: 'Unrelated', cat: 'other', ph: 'X', ts: 30, dur: 4, args: { data: { scriptId: 99 } } }
    ];
    const session = extractFromChromiumPerformanceProfile(traceEvents);
    const events = session.threads[0].events;

    assert.deepEqual(events.map(event => ({ name: event.name, cat: event.cat, tm: event.tm, duration: event.duration })), [
        { name: 'CompileCode', cat: category, tm: 10, duration: 15 },
        { name: 'CompileFunction', cat: category, tm: 20, duration: 0 },
        { name: 'Unrelated', cat: 'other', tm: 30, duration: 4 }
    ]);
    assert.equal(events[0].data, completeArgs);
    assert.equal(events[1].data, instantArgs);
    assert.deepEqual(instantArgs.data, { ...data, startAllocationId: 8454 });
    assert.deepEqual(traceEvents.map(event => event.ts), [0, 20, 10, 30]);
    assert.equal(session.threads[0].userTimings.length, 0);
    assert.equal('_events' in session.profiles[0], false);
    assert.deepEqual([...collectProfileUsedScriptIds(session.profiles[0], session.threads[0].compilations)], [5]);
    assert.deepEqual(session.threads[0].compilations!.map(record => [record.line, record.column]), [[0, 3097], [0, 3097]]);
});

test('compilation coordinates preserve reported values without deriving absent fields', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'disabled-by-default-v8.compilation_allocations', ph: 'X' };
    const coordinates = [{ line: 0, column: 0 }, { line: -1, column: -1 }, { line: 4, column: 50 }, { line: 8 }, { column: 12 }, {}];
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', ph: 'P', id: 'cpu', args: { data: { startTime: 0 } } },
        ...coordinates.map((location, index) => ({
            ...base, name: 'Compile', ts: index + 1, dur: 1,
            args: { data: { scriptId: 7, start: 20, end: 30, ...location } }
        }))
    ]);

    assert.deepEqual(session.threads[0].compilations!.map(record => [record.line, record.column]), [
        [0, 0], [-1, -1], [4, 50], [8, null], [null, 12], [null, null]
    ]);
});

test('compilation facts belong to source threads independently of captures', () => {
    const category = 'disabled-by-default-v8.compilation_allocations';
    const base = { pid: 1, tid: 2, ts: 100, cat: category, ph: 'X' };
    const data = Object.freeze({ isolate: 'first', scriptId: 7, start: 20, end: 30, startAllocationId: 10, endAllocationId: 10 });
    const first = Object.freeze({ ...base, name: 'Compile', dur: 40, args: Object.freeze({ data }) });
    const second = Object.freeze({ ...base, name: 'Parse', ts: 110, dur: 5, args: Object.freeze({ data }) });
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', tid: 3, ph: 'P', id: 'cpu', args: { data: { startTime: 0, isolate: 'cpu' } } },
        second,
        { ...base, name: 'Unrelated', cat: 'other', ts: 105, dur: 3, args: {} },
        first,
        { ...base, name: 'SimilarCategory', ts: 115, dur: 2, cat: `v8,${category}.extra`, args: {} },
        { ...base, name: 'Unknown', ts: 120, dur: 7, cat: `v8,${category}`, args: { data: { scriptId: -1, start: -1 } } },
        { ...base, name: 'NotThisSource', ts: 130, cat: 'disabled-by-default-v8.compile', dur: 8, args: {} }
    ]);
    const thread = session.threads.find(thread => thread.tid === 2)!;
    const records = thread.compilations!;

    assert.equal(session.profiles.length, 1);
    assert.equal(session.profiles[0]._tid, 3);
    assert.equal(thread.isolate, 'first');
    assert.deepEqual(records.map(record => record.name), ['Compile', 'Parse', 'Unknown']);
    assert.deepEqual(records[0], {
        name: 'Compile', tm: 100, duration: 40,
        scriptId: 7, start: 20, end: 30, line: null, column: null, functionName: null,
        allocationStart: 10, allocationEnd: 10, eventIndex: 0, event: null, callFrame: null
    });
    assert.deepEqual(records.map(record => record.eventIndex), [0, 2, 4]);
    assert.equal(thread.events[records[0].eventIndex!].data, first.args);
    assert.equal(thread.events[records[1].eventIndex!].data, second.args);
    assert.equal(records[2].scriptId, -1);
    assert.equal(records[2].allocationStart, null);
    assert.ok(records.every(record => record.event === null && record.callFrame === null && !('selfTime' in record || 'locationIndex' in record)));
    assert.equal('compilations' in session.profiles[0], false);
    assert.equal('compilations' in session.threads.find(thread => thread.tid === 3)!, false);
});

test('compilation timing keeps zero values and leaves unpaired bounds unknown', () => {
    const base = { pid: 1, tid: 2, ts: 100, cat: 'disabled-by-default-v8.compilation_allocations', ph: 'b' };
    const args = { data: { isolate: 'test', scriptId: 7, start: 14 } };
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', ph: 'P', id: 'cpu', args: { data: { startTime: 100 } } },
        { ...base, name: 'Instant', ph: 'I', ts: 0, args },
        { ...base, name: 'Compile', id: 1, args },
        { ...base, name: 'Compile', id: 1, ts: 125, ph: 'e', args },
        { ...base, name: 'Unfinished', id: 2, ts: 130, args },
        { ...base, name: 'Orphan', id: 3, ts: 140, ph: 'e', args }
    ], diagnose);
    const thread = session.threads[0];
    const records = thread.compilations!;

    assert.deepEqual(records.map(({ name, tm, duration, eventIndex }) => [name, tm, duration, eventIndex]), [
        ['Instant', 0, 0, 0],
        ['Compile', 100, 25, 1],
        ['Unfinished', 130, null, 2],
        ['Orphan', null, 140, 3]
    ]);
    assert.deepEqual([thread.events[2].tm, thread.events[2].duration], [130, -1]);
    assert.deepEqual([thread.events[3].tm, thread.events[3].duration], [-1, 140]);
    assert.deepEqual(diagnostics.map(({ message }) => message), ['Could not find start event for end event']);
});

test('CPU sample bounds do not discard compilation with captured allocation ids', () => {
    const base = { pid: 1, tid: 2, ts: 100, cat: 'profile', ph: 'P', id: 'cpu' };
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Compile', ts: 90, ph: 'X', dur: 5, cat: 'disabled-by-default-v8.compilation_allocations', args: { data: {
            isolate: 'test', scriptId: 7, start: 14, end: 30, startAllocationId: 1, endAllocationId: 3
        } } },
        { ...base, name: 'Profile', args: { data: { startTime: 100, isolate: 'test' } } },
        { ...base, name: 'ProfileChunk', ts: 200, args: { data: {
            endTime: 200, allocationSamples: { ids: [1, 2, 3], sizes: [8, 16, 32] }
        } } }
    ]);
    const profile = session.profiles[0];
    const record = session.threads[0].compilations![0];

    assert.ok(record.tm! + record.duration! < profile.startTime);
    assert.deepEqual([record.allocationStart, record.allocationEnd], [1, 3]);
    assert.deepEqual(profile._cpuproAllocationIds, new Uint32Array([1, 2, 3]));
    assert.equal(record.eventIndex, 0);
});

test('isolate routes CPU and allocation chunks regardless of producer pid and conflicting id', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P' };
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', id: 'target', args: { data: { startTime: 100, isolate: 'target-isolate' } } },
        { ...base, name: 'Profile', id: 'producer', pid: 3, ts: 1, args: { data: { startTime: 200, isolate: 'producer-isolate' } } },
        { ...base, name: 'ProfileChunk', id: 'producer', pid: 3, ts: 2, args: { data: {
            isolate: 'target-isolate', endTime: 180, cpuProfile: { samples: [11] }, timeDeltas: [10]
        } } },
        { ...base, name: 'ProfileChunk', id: 'producer', pid: 3, ts: 3, args: { data: {
            isolate: 'target-isolate', allocationSamples: { ids: [1], sizes: [16] }
        } } },
        { ...base, name: 'ProfileChunk', pid: 4, ts: 4, args: { data: {
            isolate: 'target-isolate', allocationSamples: { ids: [2], sizes: [32] }
        } } },
        { ...base, name: 'ProfileChunk', pid: 3, id: 'producer', ts: 5, args: { data: {
            endTime: 280, cpuProfile: { samples: [22] }, timeDeltas: [20]
        } } }
    ]);

    assert.deepEqual(session.profiles.map(profile => ({
        pid: profile._pid,
        tid: profile._tid,
        capture: profile._capture,
        start: profile.startTime,
        end: profile.endTime,
        samples: Array.from(profile.samples)
    })), [
        { pid: 1, tid: 2, capture: { id: 'target', isolate: 'target-isolate' }, start: 100, end: 180, samples: [11] },
        { pid: 3, tid: 2, capture: { id: 'producer', isolate: 'producer-isolate' }, start: 200, end: 280, samples: [22] }
    ]);
    assert.deepEqual(session.profiles[0]._cpuproAllocationIds, new Uint32Array([1, 2]));
    assert.deepEqual([...session.profiles[0]._cpuproAllocationSizes!], [16, 32]);
    assert.equal(session.profiles[1]._cpuproAllocationIds, undefined);
    assert.equal(session.threads.find(thread => thread.pid === 1)!.isolate, 'target-isolate');
    assert.equal(session.threads.find(thread => thread.pid === 3)!.isolate, 'producer-isolate');
});

test('an undeclared isolate does not fall back to a producer profile id', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: 'profile' };
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', args: { data: { startTime: 100, isolate: 'known' } } },
        { ...base, name: 'ProfileChunk', ts: 1, args: { data: {
            isolate: 'unknown', cpuProfile: { samples: [99] }, timeDeltas: [10]
        } } }
    ], diagnose);

    assert.deepEqual(session.profiles[0].samples, new Uint32Array());
    assert.deepEqual(diagnosticEntries(diagnostics), [
        ['Ignoring ProfileChunk for undeclared Profile', { pid: 1, id: 'profile' }]
    ]);
});

test('unknown capture isolate stays unknown', () => {
    const session = extractFromChromiumPerformanceProfile(captureEvents([]));

    assert.deepEqual(session.profiles[0]._capture, { id: '1', isolate: null });
});

test('session linking shares one linked dataset across captures and preserves source-only threads', () => {
    const base = { pid: 1, tid: 2, ts: 100, cat: 'profile', ph: 'P' };
    const category = 'disabled-by-default-v8.compilation_allocations';
    const raw = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', id: 'first', args: { data: { startTime: 100, isolate: 'shared' } } },
        { ...base, name: 'Profile', id: 'second', ts: 200, args: { data: { startTime: 200, isolate: 'shared' } } },
        { ...base, name: 'Compile', cat: category, ph: 'X', ts: 150, dur: 10, args: { data: {
            isolate: 'shared', scriptId: 7, start: 14, end: 30, startAllocationId: 1, endAllocationId: 2
        } } },
        { ...base, name: 'Compile', cat: category, ph: 'I', tid: 3, ts: 160, args: { data: {
            isolate: 'background', scriptId: 7, start: 14, end: 30
        } } }
    ]);
    const source = raw.threads.find(thread => thread.tid === 2)!;
    const background = raw.threads.find(thread => thread.tid === 3)!;
    const dictionary = new Dictionary();
    const framesBefore = dictionary.callFrames.length;
    const snapshot = JSON.stringify(source.compilations);

    const { session, profiles } = createProfileSession(raw, dictionary);
    const preparedBackground = session.processes.find(process => process.pid === 1)!.threads.find(thread => thread.tid === 3)!;

    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].thread, profiles[1].thread);
    assert.equal(profiles[0].thread.compilations, profiles[1].thread.compilations);
    assert.notEqual(profiles[0].thread.compilations, source.compilations);
    assert.ok(profiles.every(profile => !('compilations' in profile)));
    assert.equal(profiles[0].thread.compilations![0].eventIndex, 0);
    assert.equal(profiles[0].thread.compilations![0].event, source.events[0]);
    assert.equal(profiles[0].thread.isolate, 'shared');
    assert.notEqual(preparedBackground.compilations, background.compilations);
    assert.equal(preparedBackground.compilations![0].event, background.events[0]);
    assert.equal(background.compilations![0].event, null);
    assert.equal(preparedBackground.profiles.length, 0);
    assert.equal(preparedBackground.isolate, 'background');
    assert.equal(profiles[0].profile._capture, raw.profiles[0]._capture);
    assert.equal(profiles[1].profile._capture, raw.profiles[1]._capture);
    assert.notEqual(profiles[0].profile._capture, profiles[1].profile._capture);
    assert.equal(dictionary.callFrames.length, framesBefore);
    assert.equal(JSON.stringify(source.compilations), snapshot);
});

test('compilation provenance survives JSON round-trip without duplicate event objects', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: 'cpu' };
    const input = [
        { ...base, name: 'Profile', args: { data: { startTime: 0, isolate: 'test' } } },
        { ...base, name: 'Unrelated', ph: 'X', ts: 10, dur: 2, args: {} },
        { ...base, name: 'Compile', ph: 'X', ts: 20, dur: 5, cat: 'disabled-by-default-v8.compilation_allocations', args: { data: {
            isolate: 'test', scriptId: 7, start: 14, end: 30, startAllocationId: 1, endAllocationId: 2
        } } }
    ];
    const raw = extractFromChromiumPerformanceProfile(input);
    const restored = JSON.parse(JSON.stringify(raw)) as UniformProfilingSession;
    const thread = restored.threads[0];
    const record = thread.compilations![0];
    const before = JSON.stringify(restored);
    const keys = Object.keys(record);

    assert.equal(JSON.stringify(restored), JSON.stringify(raw));
    assert.deepEqual(thread, raw.threads[0]);
    assert.equal(record.eventIndex, 1);
    assert.equal(record.event, null);
    assert.equal(record.callFrame, null);
    assert.equal(thread.events[record.eventIndex!].name, 'Compile');

    const dictionary = new Dictionary();
    const { profiles } = createProfileSession(restored, dictionary);
    const runtimeThread = profiles[0].thread;
    const processingRecord = runtimeThread.compilations![0];

    assert.deepEqual(Object.keys(processingRecord), keys);
    assert.equal(processingRecord.event, runtimeThread.events[1]);
    assert.equal(processingRecord.callFrame, null);
    assert.notEqual(runtimeThread.compilations, thread.compilations);
    assert.equal(JSON.stringify(restored), before);
});

test('inconsistent thread isolates remain unresolved without grouping or discarding source facts', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'disabled-by-default-v8.compilation_allocations', ph: 'X' };
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', ph: 'P', id: 'cpu', args: { data: { startTime: 0, isolate: 'declared' } } },
        { ...base, name: 'Compile', ts: 1, dur: 1, args: { data: { isolate: 'different', scriptId: 7, start: 14 } } }
    ], diagnose);

    assert.equal(session.threads[0].isolate, null);
    assert.equal(session.threads[0].compilations!.length, 1);
    assert.equal(session.threads[0].compilations![0].eventIndex, 0);
    assert.deepEqual(diagnosticEntries(diagnostics), [
        ['Conflicting compilation isolates for thread', { pid: 1, tid: 2 }]
    ]);
});

test.each([
    { order: 'consecutive', ids: [10, 11, 12], gc: [5, 0, 5], diagnostics: [] },
    {
        order: 'ascending',
        ids: [10, 12, 15],
        gc: [5, 5, 0],
        diagnostics: [['Allocation ids are not consecutive, GC mapping will be slower', {
            index: 1, id: 10, nextId: 12, nextIndex: -1, length: 3, lastId: 15
        }]]
    },
    {
        order: 'ascending',
        ids: [10, 11, 11, 12],
        gc: [5, 0, 0, 5],
        diagnostics: [['Allocation ids are not consecutive, GC mapping will be slower', {
            index: 2, id: 11, nextId: 11, nextIndex: 3, length: 4, lastId: 12
        }]]
    }
])('GC mapping follows $order allocation ids $ids', ({ order, ids, gc, diagnostics: expected }) => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile(captureEvents([
        { allocationSamples: { ids }, allocationGc: { 5: [10, 12, 99] } }
    ]), diagnose);
    const profile = session.profiles[0];

    assert.equal(profile._cpuproAllocationIdsOrder, order);
    assert.deepEqual(profile._cpuproAllocationIds, new Uint32Array(ids));
    assert.deepEqual(profile._cpuproAllocationGc, new Uint32Array(gc));
    assert.deepEqual(diagnosticEntries(diagnostics), expected);
});

test.each([
    { values: [], order: undefined },
    { values: [10], order: 'consecutive' },
    { values: [0, 1, 2], order: 'consecutive' },
    { values: [0x7fffffff, 0x80000000, 0x80000001], order: 'consecutive' },
    { values: [0xfffffffe, 0xffffffff], order: 'consecutive' },
    { values: [10, 12, 15], order: 'ascending' },
    { values: [10, 10, 11], order: 'ascending' }
])('tracing publishes numeric order metadata of $values: $order', ({ values, order }) => {
    const session = extractFromChromiumPerformanceProfile(captureEvents([
        { allocationSamples: { ids: values } }
    ]));

    assert.equal(session.profiles[0]._cpuproAllocationIdsOrder, order);
});

test('allocation vectors parse JSON chunks once and preserve unsigned 32-bit IDs', () => {
    const parse = vi.spyOn(JSON, 'parse');

    try {
        const session = extractFromChromiumPerformanceProfile(captureEvents([' [ ] ', '[0]', '[2147483648,4294967295]'].map(ids => ({
            allocationSamples: { ids }
        }))));

        assert.deepEqual(session.profiles[0]._cpuproAllocationIds, new Uint32Array([0, 2147483648, 4294967295]));
        assert.equal(parse.mock.calls.length, 3);
    } finally {
        parse.mockRestore();
    }
});

test('tracing preserves signed CPU time deltas across chunks and repeated extraction', async () => {
    const nodes = [
        { id: 1, callFrame: { functionName: '(root)', scriptId: 0, url: '', lineNumber: -1, columnNumber: -1 }, children: [11, 22, 33, 44] },
        ...[11, 22, 33, 44].map(id => ({
            id, callFrame: { functionName: `sample${id}`, scriptId: 1, url: '/sample.js', lineNumber: 0, columnNumber: 0 }
        }))
    ];
    const chunks = [
        { cpuProfile: { nodes, samples: [11, 22] }, timeDeltas: [100, 120], allocationSampleIds: [10, 20] },
        { cpuProfile: { nodes: [], samples: [33, 44] }, timeDeltas: [-20, 110], allocationSampleIds: [30, 40], endTime: 1400 }
    ];
    const events = [
        { name: 'Profile', pid: 1, tid: 1, id: 'cpu', ts: 1000, ph: 'P', cat: '', args: { data: { startTime: 1000 } } },
        ...chunks.map(data => ({ name: 'ProfileChunk', pid: 1, tid: 1, id: 'cpu', ts: 1000, ph: 'P', cat: '', args: { data } }))
    ];

    for (let extraction = 0; extraction < 2; extraction++) {
        const profile = extractFromChromiumPerformanceProfile(events).profiles[0];

        assert.deepEqual(profile.timeDeltas, new Int32Array([100, 120, -20, 110]));
        assert.deepEqual(profile.samples, new Uint32Array([11, 22, 33, 44]));
        assert.deepEqual(profile._cpuproAllocationMapping, new Uint32Array([10, 20, 30, 40]));
        assert.deepEqual(chunks[1].timeDeltas, new Int32Array([-20, 110]));
        assert.equal(isCPUProfile(profile), true);

        const prepared = await createProfile(profile);
        const timeline = prepared.timeline!;

        assert.deepEqual(profile.samples, new Uint32Array([11, 33, 22, 44]));
        assert.deepEqual(profile._cpuproAllocationMapping, new Uint32Array([10, 30, 20, 40]));
        assert.deepEqual(timeline.values, new Uint32Array([100, 20, 90, 90]));
        assert.equal(timeline.axisTotal, 300);
        assert.equal(timeline.axisStartNoSamples, 100);
        assert.equal(timeline.axisEndNoSamples, 0);
        assert.deepEqual(timeline.breakdowns[0].population.cumulative, new Float64Array([0, 100, 120, 210]));
        assert.deepEqual(chunks[1].timeDeltas, new Int32Array([-20, 110]));
    }
});

test('tracing vector representations preserve unsigned 32-bit values and signed offsets', () => {
    const allocationSamples = {
        ids: '[4294967295]', sizes: '[4294967295]', scriptIds: '[-1]', scriptOffsets: '[-1]',
        contextInfo: '[2147483648]', types: '[4294967295]', spaces: '[2147483648]',
        codeTypes: '[2147483648]', gc: '[2147483649]'
    };
    const chunk = {
        cpuProfile: { nodes: [], samples: [0xffffffff] }, timeDeltas: [10],
        lines: [-1], columns: [-1], allocationSampleIds: [0xffffffff], allocationSamples
    };
    const events = captureEvents([chunk]);
    const profile = extractFromChromiumPerformanceProfile(events).profiles[0];

    assert.deepEqual(profile.samples, new Uint32Array([0xffffffff]));
    assert.deepEqual(profile.timeDeltas, new Int32Array([10]));
    assert.deepEqual(profile.lines, new Int32Array([-1]));
    assert.deepEqual(profile.columns, new Int32Array([-1]));
    assert.deepEqual(profile._cpuproAllocationMapping, new Uint32Array([0xffffffff]));
    assert.deepEqual(profile._cpuproAllocationIds, new Uint32Array([0xffffffff]));
    assert.deepEqual(profile._cpuproAllocationSizes, new Uint32Array([0xffffffff]));
    assert.deepEqual(profile._cpuproAllocationScriptIds, new Int32Array([-1]));
    assert.deepEqual(profile._cpuproAllocationLocations, new Int32Array([-1]));
    assert.deepEqual(profile._cpuproAllocationContextInfo, new Uint32Array([0x80000000]));
    assert.deepEqual(profile._cpuproAllocationTypes, new Uint32Array([0xffffffff]));
    assert.deepEqual(profile._cpuproAllocationSpaces, new Uint32Array([0x80000000]));
    assert.deepEqual(profile._cpuproAllocationCodeType, new Uint32Array([0x80000000]));
    assert.deepEqual(profile._cpuproAllocationGc, new Uint32Array([0x80000001]));
    assert.deepEqual(allocationSamples.sizes, profile._cpuproAllocationSizes);
    assert.deepEqual(allocationSamples.scriptOffsets, profile._cpuproAllocationLocations);
    assert.deepEqual(allocationSamples.ids, profile._cpuproAllocationIds);
    assert.deepEqual(extractFromChromiumPerformanceProfile(events).profiles[0], profile);
});

test('allocation dictionaries without vectors do not require an IDs field', () => {
    const allocationSamples = { typesDict: { 1: 'OBJECT' } };
    const session = extractFromChromiumPerformanceProfile(captureEvents([
        { cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10], allocationSamples }
    ]));

    assert.deepEqual(session.profiles[0].samples, new Uint32Array([1]));
    assert.deepEqual(publishedAllocations(session.profiles[0]), {});
    assert.deepEqual(allocationSamples, { typesDict: { 1: 'OBJECT' } });
});

test('allocation dictionaries are merged across chunks and published with their vectors', () => {
    const session = extractFromChromiumPerformanceProfile(captureEvents([
        { allocationSamples: {
            ids: [1], contextInfo: [3], types: [1], spaces: [0], codeTypes: [0],
            builtinsDict: { 3: 'ArrayPush' }, vmStatesDict: { 0: 'JS' },
            typesDict: { 1: 'OBJECT' }, spacesDict: { 0: 'new' }, codeTypesDict: { 0: 'Interpreted' }
        } },
        { allocationSamples: {
            ids: [2], contextInfo: [4], types: [2], spaces: [1], codeTypes: [1],
            builtinsDict: { 4: 'StringAdd' }, vmStatesDict: { 1: 'GC' },
            typesDict: { 2: 'STRING' }, spacesDict: { 1: 'old' }, codeTypesDict: { 1: 'Optimized' }
        } }
    ]));

    assert.deepEqual(publishedAllocations(session.profiles[0]), {
        _cpuproAllocationIds: new Uint32Array([1, 2]),
        _cpuproAllocationIdsOrder: 'consecutive',
        _cpuproAllocationContextInfo: new Uint32Array([3, 4]),
        _cpuproAllocationBuiltinNames: { 3: 'ArrayPush', 4: 'StringAdd' },
        _cpuproAllocationVmStateNames: { 0: 'JS', 1: 'GC' },
        _cpuproAllocationTypes: new Uint32Array([1, 2]),
        _cpuproAllocationTypeNames: { 1: 'OBJECT', 2: 'STRING' },
        _cpuproAllocationSpaces: new Uint32Array([0, 1]),
        _cpuproAllocationSpaceNames: { 0: 'new', 1: 'old' },
        _cpuproAllocationCodeType: new Uint32Array([0, 1]),
        _cpuproAllocationCodeTypeNames: { 0: 'Interpreted', 1: 'Optimized' }
    });
});

test('missing later allocation vectors do not shift rows silently', () => {
    assert.throws(() => extractFromChromiumPerformanceProfile(captureEvents([
        { allocationSamples: { ids: [1], sizes: [8] } },
        { allocationSamples: { ids: [2] } },
        { allocationSamples: { ids: [3], sizes: [16] } }
    ])), /Missing allocation vector sizes/);
});

// Trace content with typed vectors read as arrays: extraction may only change the vector representation
function traceContent(input: unknown) {
    return JSON.parse(JSON.stringify(input, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as Int32Array) : value));
}

test.each([{ ids: [10, 9, 12] }, { ids: [10, 12, 11] }])('rejects unsorted allocation rows including inversions across chunks: $ids', ({ ids }) => {
    const input = [
        ...captureEvents([ids.slice(0, 2), ids.slice(2)].map((part, index) => ({
            cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10], allocationSampleIds: [10 + index * 10],
            allocationSamples: { ids: part, sizes: part.map(() => 8), types: part.map(() => 1), typesDict: { 1: 'OBJECT' } },
            allocationGc: { 5: part }
        }))),
        { ...capture, name: 'Compile', ph: 'X', cat: 'disabled-by-default-v8.compilation_allocations', dur: 1,
            args: { data: { scriptId: 1, start: 0, startAllocationId: 9, endAllocationId: 12 } } }
    ];
    const before = structuredClone(input);
    const { diagnostics, diagnose } = createDiagnosticsCollector();

    const session = extractFromChromiumPerformanceProfile(input, diagnose);
    const profile = session.profiles[0];

    assert.deepEqual(profile.samples, new Uint32Array([1, 1]));
    assert.deepEqual(profile.timeDeltas, new Int32Array([10, 10]));
    assert.deepEqual(publishedAllocations(profile), { _cpuproAllocationMapping: new Uint32Array([10, 20]) });
    assert.equal(session.threads[0].compilations!.length, 1);
    assert.deepEqual(diagnosticEntries(diagnostics), [['Ignoring allocation data with unsorted IDs', { pid: 1, tid: 2 }]]);
    assert.deepEqual(traceContent(input), before);
});

test.each([
    // multi-digit ids, since a JSON string indexed by characters may pass for one-digit ids
    { order: 'consecutive', ids: [[11, 12], [13], [14, 15]] },
    { order: 'ascending', ids: [[11, 12], [14], [16, 17]] }
])('allocation vectors encoded as JSON strings, arrays or both give the same result across chunks: $order ids', ({ ids }) => {
    // Traces encode allocation vectors as JSON.stringify(numbers) or as arrays of numbers
    const chunkVectors = ids.map((chunkIds, index) => ({
        allocationSamples: {
            ids: chunkIds,
            sizes: chunkIds.map(id => id * 8),
            scriptIds: chunkIds.map(() => index),
            scriptOffsets: chunkIds.map(id => id === 11 ? -1 : id),
            contextInfo: chunkIds.map(id => id % 2),
            types: chunkIds.map(() => 0xffffffff - index),
            spaces: chunkIds.map(() => index),
            codeTypes: chunkIds.map(() => 1),
            gc: chunkIds.map(() => 0)
        },
        allocationGc: { [5 + index * 4]: [chunkIds[0]] }
    }));
    const encode = (encodeVector: (vector: number[], index: number) => number[] | string) =>
        captureEvents(chunkVectors.map(({ allocationSamples, allocationGc }, index) => ({
            allocationSamples: {
                ...Object.fromEntries(Object.entries(allocationSamples).map(([key, vector]) => [key, encodeVector(vector, index)])),
                typesDict: { [0xffffffff - index]: 'TYPE' + index }
            },
            allocationGc: Object.fromEntries(Object.entries(allocationGc).map(([key, vector]) => [key, encodeVector(vector, index)]))
        })));
    const extract = (events: ReturnType<typeof captureEvents>) => {
        const { diagnose } = createDiagnosticsCollector();

        return publishedAllocations(extractFromChromiumPerformanceProfile(events, diagnose).profiles[0]);
    };
    const fromArrays = extract(encode(vector => vector));

    const gcById = new Map(ids.map((chunkIds, index) => [chunkIds[0], 5 + index * 4]));

    assert.deepEqual(fromArrays._cpuproAllocationIds, new Uint32Array(ids.flat()));
    assert.deepEqual(fromArrays._cpuproAllocationGc, new Uint32Array(ids.flat().map(id => gcById.get(id) ?? 0)));
    assert.deepEqual(extract(encode(vector => JSON.stringify(vector))), fromArrays);
    assert.deepEqual(extract(encode((vector, index) => index === 1 ? vector : JSON.stringify(vector))), fromArrays);
});

test('ProfileChunk releases numeric source arrays without mutating metadata and can be extracted again', () => {
    const typesDict = { 1: 'OBJECT' };
    const allocationSamples = { ids: '[10,12]', sizes: [8, 16], types: [1, 1], typesDict };
    const allocationGc = { '005': '[12]' };
    const input = captureEvents([{ allocationSamples, allocationGc }]);
    const { diagnose } = createDiagnosticsCollector();
    const first = extractFromChromiumPerformanceProfile(input, diagnose);

    assert.deepEqual(allocationSamples.ids, new Uint32Array([10, 12]));
    assert.deepEqual(allocationGc['005'], new Uint32Array([12]));
    assert.deepEqual(Object.keys(allocationGc), ['005']);
    assert.equal(allocationSamples.typesDict, typesDict);

    const second = extractFromChromiumPerformanceProfile(input, diagnose);

    assert.deepEqual(second, first);
});

test('ProfileChunk typed vectors supplied whole are adopted without copies', () => {
    const ids = new Int32Array([10, 12]);
    const sizes = new Int32Array([8, 16]);
    const scriptOffsets = new Int32Array([-1, 4]);
    const empty = new Int32Array(0);
    const input = captureEvents([
        {
            cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10], allocationSampleIds: new Int32Array([12]),
            allocationSamples: { ids, sizes, scriptOffsets }
        },
        { allocationSamples: { ids: empty, sizes: empty, scriptOffsets: empty } }
    ]);
    const profile = extractFromChromiumPerformanceProfile(input).profiles[0];

    assert.equal((profile._cpuproAllocationIds as Uint32Array).buffer, ids.buffer);
    assert.equal((profile._cpuproAllocationSizes as Uint32Array).buffer, sizes.buffer);
    assert.equal(profile._cpuproAllocationLocations, scriptOffsets);
    assert.deepEqual(profile._cpuproAllocationSizes, new Uint32Array([8, 16]));
    assert.deepEqual(profile._cpuproAllocationMapping, new Uint32Array([12]));
});

// The jsonxl layout: chunk allocation vectors are null, their concatenation per producer is in metadata
// (a factory since extraction decodes chunk vectors in place)
const detachedAllocationSamples = () => ({ ids: null, sizes: null, scriptOffsets: null, typesDict: { 1: 'OBJECT' } });

test('allocation vectors of detached chunks are taken from metadata by producer without copies', () => {
    const ids = new Int32Array([10, 11, 12]);
    const sizes = new Int32Array([8, 16, -1]);
    const scriptOffsets = new Int32Array([-1, 4, 5]);
    const types = new Int32Array([1, 1, 1]);
    const gc = new Int32Array([11]);
    // chunks produced by another thread are routed to the capture by its pid and id
    const producerChunk = (data: object) => ({ ...capture, tid: 8, name: 'ProfileChunk', args: { data } });
    const session = extractFromChromiumPerformanceProfile({
        traceEvents: [
            ...captureEvents([{ cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10], allocationSampleIds: new Int32Array([12]) }]),
            producerChunk({ allocationSamples: { ...detachedAllocationSamples(), types: null } }),
            producerChunk({ allocationSamples: { ...detachedAllocationSamples(), types: null, typesDict: { 2: 'STRING' } } }),
            producerChunk({ allocationGc: { 9: null } })
        ],
        metadata: { allocationVectors: [
            { pid: 1, tid: 8, name: 'allocationSamples.ids', data: ids },
            { pid: 1, tid: 8, name: 'allocationSamples.sizes', data: sizes },
            { pid: 1, tid: 8, name: 'allocationSamples.scriptOffsets', data: scriptOffsets },
            { pid: 1, tid: 8, name: 'allocationSamples.types', data: types },
            { pid: 1, tid: 8, name: 'allocationGc.9', data: gc },
            { pid: 1, tid: 2, name: 'allocationSamples.ids', data: new Int32Array([1]) }
        ] }
    });
    const profile = session.profiles[0];

    assert.equal((profile._cpuproAllocationIds as Uint32Array).buffer, ids.buffer);
    assert.equal((profile._cpuproAllocationSizes as Uint32Array).buffer, sizes.buffer);
    assert.equal(profile._cpuproAllocationLocations, scriptOffsets);
    assert.deepEqual(publishedAllocations(profile), {
        _cpuproAllocationMapping: new Uint32Array([12]),
        _cpuproAllocationIds: new Uint32Array([10, 11, 12]),
        _cpuproAllocationIdsOrder: 'consecutive',
        _cpuproAllocationSizes: new Uint32Array([8, 16, 0xffffffff]),
        _cpuproAllocationLocations: new Int32Array([-1, 4, 5]),
        _cpuproAllocationTypes: new Uint32Array([1, 1, 1]),
        _cpuproAllocationTypeNames: { 1: 'OBJECT', 2: 'STRING' },
        _cpuproAllocationGc: new Uint32Array([0, 9, 0])
    });
});

test.each([
    {
        title: 'missing in metadata',
        producers: [1],
        message: 'Ignoring allocation data with vectors missing in metadata',
        details: { pid: 1, tid: 2, producers: ['1:2'] }
    },
    {
        title: 'of several producers',
        producers: [1, 3],
        message: 'Ignoring allocation data with metadata vectors of several producers',
        details: { pid: 1, tid: 2, producers: ['1:2', '3:2'] }
    }
])('detached allocation vectors $title are reported instead of being dropped silently', ({ producers, message, details }) => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractFromChromiumPerformanceProfile({
        traceEvents: [
            ...captureEvents([{ cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10] }]),
            ...producers.map(pid => ({ ...capture, pid, name: 'ProfileChunk', args: { data: {
                isolate: 'target', allocationSamples: detachedAllocationSamples(), allocationGc: { 9: null }
            } } }))
        ].map(event => event.name === 'Profile' ? { ...event, args: { data: { startTime: 0, isolate: 'target' } } } : event),
        metadata: { allocationVectors: [
            { pid: 9, tid: 2, name: 'allocationSamples.ids', data: new Int32Array([1]) },
            ...producers.length > 1 ? producers.map(pid => ({ pid, tid: 2, name: 'allocationSamples.ids', data: new Int32Array([1]) })) : []
        ] }
    }, diagnose);

    assert.deepEqual(publishedAllocations(session.profiles[0]), {});
    assert.deepEqual(diagnosticEntries(diagnostics), [[message, details]]);
});

test('reports extraction problems to the provided diagnose instead of the console', () => {
    const userTiming = { pid: 1, tid: 2, cat: 'blink.user_timing', args: { traceId: 1 } };
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        extractFromChromiumPerformanceProfile([
            ...captureEvents([]),
            { ...userTiming, name: 'Mark', ph: 'e', ts: 5, id: 'a' },
            { ...userTiming, name: 'Mark', ph: 'e', ts: 6 },
            { ...capture, name: 'ProfileChunk', id: 'unknown', args: { data: {} } }
        ], diagnose);

        assert.deepEqual(warning.mock.calls, []);
        assert.deepEqual(diagnostics, [
            {
                level: 'warn',
                scope: [],
                message: 'Ignoring ProfileChunk for undeclared Profile',
                details: { pid: 1, id: 'unknown' }
            },
            {
                level: 'warn',
                scope: [],
                message: 'Could not find start event for end event',
                details: {
                    eventId: 'Mark:a',
                    cat: 'blink.user_timing',
                    name: 'Mark',
                    pid: 1,
                    tid: 2
                }
            },
            {
                level: 'warn',
                scope: [],
                message: 'Ignoring end event without id',
                details: { cat: 'blink.user_timing', name: 'Mark', pid: 1, tid: 2 }
            }
        ]);
    } finally {
        warning.mockRestore();
    }
});

test('tracing preserves CPU-aligned allocation mapping without allocation rows', () => {
    const input = captureEvents([
        { cpuProfile: { nodes: [], samples: [1, 2] }, timeDeltas: [10, 10], allocationSampleIds: [10, 15] },
        { cpuProfile: { nodes: [], samples: [3] }, timeDeltas: [10], allocationSampleIds: [20] }
    ]);
    const before = structuredClone(input);

    const session = extractFromChromiumPerformanceProfile(input);

    assert.equal(session.profiles.length, 1);
    assert.deepEqual(session.profiles[0].samples, new Uint32Array([1, 2, 3]));
    assert.deepEqual(session.profiles[0].timeDeltas, new Int32Array([10, 10, 10]));
    assert.deepEqual(publishedAllocations(session.profiles[0]), { _cpuproAllocationMapping: new Uint32Array([10, 15, 20]) });
    assert.deepEqual(traceContent(input), before);
});

test('CPU-only profiles are published without allocation fields and retain node order and trace ids', () => {
    const first = { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 } };
    const second = { ...first, id: 2 };
    const session = extractFromChromiumPerformanceProfile(captureEvents([
        { cpuProfile: { nodes: [first], trace_ids: { first: 1 } } },
        {},
        { allocationSampleIds: [] },
        { cpuProfile: { nodes: [second], trace_ids: { second: 2 } } }
    ]));

    assert.equal(session.profiles.length, 1);
    assert.deepEqual(Object.keys(session.profiles[0]).filter(key => key.startsWith('_cpuproAllocation')), []);
    assert.deepEqual(session.profiles[0].nodes, [first, second]);
    assert.deepEqual(session.profiles[0].trace_ids, { first: 1, second: 2 });
});

test.each([
    { vectors: 'lines', chunk: { lines: [5] }, lines: undefined, columns: undefined },
    { vectors: 'columns', chunk: { columns: [6] }, lines: undefined, columns: undefined },
    { vectors: 'lines and columns', chunk: { lines: [5], columns: [6] }, lines: new Int32Array([0, 5]), columns: new Int32Array([0, 6]) }
])('line and column vectors are published as a sample-aligned pair: $vectors', ({ chunk, lines, columns }) => {
    const profile = extractFromChromiumPerformanceProfile(captureEvents([
        { cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10] },
        { cpuProfile: { nodes: [], samples: [2] }, timeDeltas: [10], ...chunk }
    ])).profiles[0];

    assert.deepEqual(profile.samples, new Uint32Array([1, 2]));
    assert.deepEqual(profile.lines, lines);
    assert.deepEqual(profile.columns, columns);
});

test('capture end time is the latest end time reported by its chunks', () => {
    const profile = extractFromChromiumPerformanceProfile(captureEvents([
        { endTime: 200 },
        { endTime: 300 },
        { endTime: 250 },
        {}
    ])).profiles[0];

    assert.deepEqual([profile.startTime, profile.endTime], [0, 300]);
});

// Catchups are delivered in reverse trace order; extraction applies them in timestamp order
function scriptCatchupEvents(catchups: { name?: string; pid?: number; tid?: number; data: Record<string, unknown> }[]) {
    const base = { ph: 'X', cat: 'disabled-by-default-v8.source' };

    return [
        ...captureEvents([]),
        ...catchups.map(({ name = 'ScriptCatchup', pid = 1, tid = 2, data }, index) => ({
            ...base, name, pid, tid, ts: index + 1, args: { data }
        })).reverse()
    ];
}

function extractScriptCatchups(catchups: Parameters<typeof scriptCatchupEvents>[0], diagnose?: Diagnose) {
    return extractFromChromiumPerformanceProfile(scriptCatchupEvents(catchups), diagnose);
}

function largeCatchup(data: Record<string, unknown>) {
    return { name: 'LargeScriptCatchup', data };
}

function diagnoseScriptCatchups(catchups: Parameters<typeof scriptCatchupEvents>[0]) {
    const { diagnostics, diagnose } = createDiagnosticsCollector();

    extractScriptCatchups(catchups, diagnose);

    return diagnosticEntries(diagnostics);
}

function sourceMapEntry(url: string, sourceMapUrl: string, file: string) {
    return { url, sourceMapUrl, sourceMap: { version: '3', file, sources: [], names: [], mappings: '' } };
}

const exactSourceMap = sourceMapEntry('', 'app.js.map', 'exact');
const resolvedSourceMap = sourceMapEntry('', 'https://site/app.js.map', 'resolved');
const scriptSourceMap = sourceMapEntry('https://site/app.js', '', 'script');

test.each([
    {
        resolution: 'the reported source map URL first',
        sourceMaps: [scriptSourceMap, resolvedSourceMap, exactSourceMap],
        expected: exactSourceMap.sourceMap
    },
    {
        resolution: 'the source map URL resolved against the script URL',
        sourceMaps: [scriptSourceMap, resolvedSourceMap],
        expected: resolvedSourceMap.sourceMap
    },
    {
        resolution: 'the script URL',
        sourceMaps: [scriptSourceMap],
        expected: scriptSourceMap.sourceMap
    },
    {
        resolution: 'no script URL shared by several source maps',
        sourceMaps: ['first', 'second', 'third'].map(file => sourceMapEntry('https://site/app.js', '', file)),
        expected: null
    }
])('attaches metadata source maps to scripts by $resolution', ({ sourceMaps, expected }) => {
    const session = extractFromChromiumPerformanceProfile({
        traceEvents: scriptCatchupEvents([{ data: { scriptId: 5, url: 'https://site/app.js', sourceMapUrl: 'app.js.map' } }]),
        metadata: { sourceMaps }
    });

    assert.equal(session.threads[0].scripts![0].sourceMap, expected);
    assert.equal(session.profiles[0]._scripts![0], session.threads[0].scripts![0]);
});

test('repeated full source catchups replace text without duplicating it or losing metadata', () => {
    const sourceText = 'globalThis.value = 1;\n//# sourceMappingURL=fixture.js.map';
    const session = extractScriptCatchups([
        { data: { scriptId: 5, url: 'fixture.js', lineOffset: 6, columnOffset: 225 } },
        { data: { scriptId: 5, sourceText } },
        { data: { scriptId: 5, sourceMapUrl: 'fixture.js.map' } },
        { data: { scriptId: 5, sourceText } },
        { data: { scriptId: 5, sourceText } }
    ]);
    const scripts = session.threads[0].scripts!;

    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].source, sourceText);
    assert.equal(scripts[0].url, 'fixture.js');
    assert.equal(scripts[0].sourceMapUrl, 'fixture.js.map');
    assert.equal(scripts[0].lineOffset, 6);
    assert.equal(scripts[0].columnOffset, 225);
    assert.equal(session.profiles[0]._scripts![0], scripts[0]);
    assert.equal('_events' in session.profiles[0], false);
});

test('assembles indexed source chunks without dropping equal text or appending repeated deliveries', () => {
    const chunk = (splitIndex: number, sourceText: string) => ({
        name: 'LargeScriptCatchup', data: { scriptId: 5, splitCount: 3, splitIndex, sourceText }
    });
    const session = extractScriptCatchups([
        chunk(2, 'tail'), chunk(0, 'same'), chunk(0, 'same'), chunk(1, 'same'),
        chunk(0, 'same'), chunk(1, 'same'), chunk(2, 'tail')
    ]);

    assert.equal(session.threads[0].scripts![0].source, 'samesametail');
});

test.each([false, true])('does not publish incomplete chunk sets, existing source: %s', existing => {
    const session = extractScriptCatchups([
        ...(existing ? [{ data: { scriptId: 5, sourceText: 'complete' } }] : []),
        { name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex: 0, splitCount: 3, sourceText: 'first' } },
        { name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex: 2, splitCount: 3, sourceText: 'last' } },
        { name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex: 0, splitCount: 3, sourceText: 'first' } },
        { data: { scriptId: 5, url: 'fixture.js' } }
    ]);

    assert.equal(session.threads[0].scripts![0].source, existing ? 'complete' : null);
    assert.equal(session.threads[0].scripts![0].url, 'fixture.js');
});

test('a full catchup replaces previous text and discards pending chunks', () => {
    const session = extractScriptCatchups([
        { data: { scriptId: 5, sourceText: 'previous' } },
        { name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex: 0, splitCount: 2, sourceText: 'pending' } },
        { data: { scriptId: 5, sourceText: '' } },
        { name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex: 1, splitCount: 2, sourceText: 'tail' } }
    ]);

    assert.equal(session.threads[0].scripts![0].source, '');
});

test('does not report identical redeliveries of script source', () => {
    const chunk = (splitIndex: number) => largeCatchup({
        scriptId: 6,
        splitCount: 2,
        splitIndex,
        sourceText: 'part'
    });

    assert.deepEqual(diagnoseScriptCatchups([
        { data: { scriptId: 5, sourceText: 'full' } },
        { data: { scriptId: 5, sourceText: 'full' } },
        chunk(0), chunk(0), chunk(1)
    ]), []);
});

test('reports script source redelivered with different content', () => {
    const chunk = (sourceText: string) => largeCatchup({
        scriptId: 5,
        splitCount: 2,
        splitIndex: 0,
        sourceText
    });

    assert.deepEqual(diagnoseScriptCatchups([
        { data: { scriptId: 5, sourceText: 'one' } },
        { data: { scriptId: 5, sourceText: 'two' } },
        chunk('first'), chunk('other')
    ]), [
        ['Script source redelivered with different content', { scriptId: 5, pid: 1, tid: 2 }],
        ['Script source chunk redelivered with different content', {
            scriptId: 5, pid: 1, tid: 2, splitIndex: 0
        }],
        ['Incomplete script source chunks left after extraction', {
            scriptId: 5, url: null, splitCount: 2, received: 1
        }]
    ]);
});

test('reports script source of a non-string type and invalid chunk metadata', () => {
    assert.deepEqual(diagnoseScriptCatchups([
        { data: { scriptId: 5, sourceText: 42 } },
        largeCatchup({ scriptId: 5, splitIndex: 2, splitCount: 2, sourceText: 'x' })
    ]), [
        ['Ignoring script source of a non-string type', {
            scriptId: 5, pid: 1, tid: 2, type: 'number'
        }],
        ['Ignoring script source chunk with invalid split metadata', {
            scriptId: 5, pid: 1, tid: 2, splitCount: 2, splitIndex: 2
        }]
    ]);
});

test('reports incomplete chunks dropped by a snapshot or by a changed split count', () => {
    const chunk = (splitIndex: number, splitCount: number) => largeCatchup({
        scriptId: 5,
        splitIndex,
        splitCount,
        sourceText: 'part'
    });

    assert.deepEqual(diagnoseScriptCatchups([
        chunk(0, 3), { data: { scriptId: 5, sourceText: 'full' } },
        chunk(0, 2), chunk(0, 3), chunk(1, 3), chunk(2, 3)
    ]), [
        ['Script source snapshot discards incomplete chunks', {
            scriptId: 5, pid: 1, tid: 2, received: 1, splitCount: 3
        }],
        ['Script source split count changed, dropping incomplete chunks', {
            scriptId: 5, pid: 1, tid: 2, splitCount: 2, newSplitCount: 3, received: 1
        }],
        ['Script source redelivered with different content', { scriptId: 5, pid: 1, tid: 2 }]
    ]);
});

test('keeps chunk sets separate by script, thread and process', () => {
    const identities = [{ pid: 1, tid: 2, scriptId: 5 }, { pid: 1, tid: 2, scriptId: 6 }, { pid: 1, tid: 3, scriptId: 5 }, { pid: 2, tid: 2, scriptId: 5 }];
    const session = extractScriptCatchups([0, 1].flatMap(splitIndex => identities.map(({ pid, tid, scriptId }) => ({
        pid, tid, name: 'LargeScriptCatchup', data: {
            scriptId, splitIndex, splitCount: 2, sourceText: splitIndex === 0 ? `${pid}:${tid}:${scriptId}` : ':end'
        }
    }))));

    for (const { pid, tid, scriptId } of identities) {
        const thread = session.threads.find(thread => thread.pid === pid && thread.tid === tid)!;
        assert.equal(thread.scripts!.find(script => script.id === scriptId)!.source, `${pid}:${tid}:${scriptId}:end`);
    }
});

test('replaces completed chunk sets and restarts when the split count changes', () => {
    const chunk = (splitIndex: number, splitCount: number, sourceText: string) => ({
        name: 'LargeScriptCatchup', data: { scriptId: 5, splitIndex, splitCount, sourceText }
    });
    const session = extractScriptCatchups([
        chunk(0, 2, 'old'), chunk(1, 2, 'text'),
        chunk(0, 3, 'abandoned'),
        chunk(1, 2, ''), chunk(0, 2, 'new')
    ]);

    assert.equal(session.threads[0].scripts![0].source, 'new');
});

test.each([
    {},
    { splitIndex: 0, splitCount: '2' },
    { splitIndex: '0', splitCount: 2 },
    { splitIndex: 0, splitCount: null },
    { splitIndex: null, splitCount: 2 },
    { splitIndex: 0, splitCount: 0 },
    { splitIndex: -1, splitCount: 2 },
    { splitIndex: 2, splitCount: 2 },
    { splitIndex: 0.5, splitCount: 2 },
    { splitIndex: 0, splitCount: 1.5 },
    { splitIndex: 0, splitCount: Infinity },
    { splitIndex: NaN, splitCount: 2 }
])('does not concatenate large catchups with invalid chunk metadata: %j', metadata => {
    const data = Object.freeze({ scriptId: 5, sourceText: 'partial', ...metadata });
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = extractScriptCatchups([
        { data: { scriptId: 5, sourceText: 'complete' } },
        { name: 'LargeScriptCatchup', data }
    ], diagnose);

    assert.equal(session.threads[0].scripts![0].source, 'complete');
    assert.equal(data.sourceText, 'partial');
    assert.deepEqual(diagnostics.map(({ message }) => message), ['Ignoring script source chunk with invalid split metadata']);
});
