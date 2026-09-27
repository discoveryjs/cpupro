import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { extractFromChromiumPerformanceProfile } from './chromium-performance-profile.js';
import { unwrapSamplesIfNeeded } from './cpuprofile.js';
import { collectProfileUsedScriptIds } from '../preprocessing/scripts.js';
import { getNumericArrayOrder } from './utils.js';
import { Dictionary } from '../dictionary.js';
import { createProfileSession } from '../profile-session.mjs';
import type { UniformProfilingSession } from './types.js';

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
    assert.deepEqual(records.map(record => record.eventIndex), [0, 2, 3]);
    assert.equal(thread.events[records[0].eventIndex!].data, first.args);
    assert.equal(thread.events[records[1].eventIndex!].data, second.args);
    assert.equal(records[2].scriptId, -1);
    assert.equal(records[2].allocationStart, null);
    assert.ok(records.every(record => record.event === null && record.callFrame === null && !('selfTime' in record || 'locationIndex' in record)));
    assert.equal('compilations' in session.profiles[0], false);
    assert.equal('compilations' in session.threads.find(thread => thread.tid === 3)!, false);
});

test('compilation extraction waits for source event pairing without inventing missing duration', () => {
    const base = { pid: 1, tid: 2, ts: 100, cat: 'disabled-by-default-v8.compilation_allocations', ph: 'b' };
    const args = { data: { isolate: 'test', scriptId: 7, start: 14 } };
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', ph: 'P', id: 'cpu', args: { data: { startTime: 100 } } },
        { ...base, name: 'Compile', id: 1, args },
        { ...base, name: 'Compile', id: 1, ts: 125, ph: 'e', args },
        { ...base, name: 'Unfinished', id: 2, ts: 130, args }
    ]);
    const records = session.threads[0].compilations!;

    assert.deepEqual(records.map(record => record.duration), [25, null]);
    assert.equal(records[0].eventIndex, 0);
    assert.equal(session.threads[0].events[records[1].eventIndex!].duration, -1);
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
    assert.deepEqual(profile._cpuproAllocationIds, [1, 2, 3]);
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
        samples: profile.samples
    })), [
        { pid: 1, tid: 2, capture: { id: 'target', isolate: 'target-isolate' }, start: 100, end: 180, samples: [11] },
        { pid: 3, tid: 2, capture: { id: 'producer', isolate: 'producer-isolate' }, start: 200, end: 280, samples: [22] }
    ]);
    assert.deepEqual(session.profiles[0]._cpuproAllocationIds, [1, 2]);
    assert.deepEqual([...session.profiles[0]._cpuproAllocationSizes!], [16, 32]);
    assert.equal(session.profiles[1]._cpuproAllocationIds, undefined);
    assert.equal(session.threads.find(thread => thread.pid === 1)!.isolate, 'target-isolate');
    assert.equal(session.threads.find(thread => thread.pid === 3)!.isolate, 'producer-isolate');
});

test('an undeclared isolate does not fall back to a producer profile id', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: 'profile' };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const session = extractFromChromiumPerformanceProfile([
            { ...base, name: 'Profile', args: { data: { startTime: 100, isolate: 'known' } } },
            { ...base, name: 'ProfileChunk', ts: 1, args: { data: {
                isolate: 'unknown', cpuProfile: { samples: [99] }, timeDeltas: [10]
            } } }
        ]);

        assert.deepEqual(session.profiles[0].samples, []);
        assert.equal(warning.mock.calls.length, 1);
    } finally {
        warning.mockRestore();
    }
});

test('unknown capture isolate stays unknown', () => {
    const session = extractScriptCatchups([]);

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
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const session = extractFromChromiumPerformanceProfile([
            { ...base, name: 'Profile', ph: 'P', id: 'cpu', args: { data: { startTime: 0, isolate: 'declared' } } },
            { ...base, name: 'Compile', ts: 1, dur: 1, args: { data: { isolate: 'different', scriptId: 7, start: 14 } } }
        ]);

        assert.equal(session.threads[0].isolate, null);
        assert.equal(session.threads[0].compilations!.length, 1);
        assert.equal(session.threads[0].compilations![0].eventIndex, 0);
        assert.equal(warning.mock.calls.length, 1);
    } finally {
        warning.mockRestore();
    }
});

test('allocation order is shared by GC mapping and compilation preparation', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        for (const ids of [[10, 11, 12], [10, 12, 15]]) {
            warning.mockClear();

            const session = extractFromChromiumPerformanceProfile([
                { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
                { ...base, name: 'ProfileChunk', args: { data: {
                    allocationSamples: { ids, sizes: [8, 16, 32] },
                    allocationGc: { 5: [10, 12, 99] }
                } } }
            ]);
            const profile = session.profiles[0];
            const order = ids[1] === 11 ? 'consecutive' : 'ascending';

            assert.equal(profile._cpuproAllocationIdsOrder, order);
            assert.deepEqual(profile._cpuproAllocationIds, ids);
            assert.deepEqual(profile._cpuproAllocationGc, ids.map(id => id === 10 || id === 12 ? 5 : 0));
            assert.equal(warning.mock.calls.length, order === 'consecutive' ? 0 : 1);
        }
    } finally {
        warning.mockRestore();
    }
});

test('tracing publishes numeric order metadata', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
    const cases = [
        { values: [], order: 'consecutive' },
        { values: [10], order: 'consecutive' },
        { values: [-2, -1, 0], order: 'consecutive' },
        { values: [0.5, 1.5, 2.5], order: 'consecutive' },
        { values: [10, 12, 15], order: 'ascending' },
        { values: [10, 10, 11], order: 'ascending' }
    ];

    for (const { values, order } of cases) {
        const session = extractFromChromiumPerformanceProfile([
            { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
            { ...base, name: 'ProfileChunk', args: { data: { allocationSamples: { ids: values } } } }
        ]);

        assert.equal(session.profiles[0]._cpuproAllocationIdsOrder, values.length ? order : undefined);
    }
});

test.each([{ ids: [10, 9, 12] }, { ids: [10, 12, 11] }])('rejects unsorted allocation rows including inversions across chunks: $ids', ({ ids }) => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
    const chunks = [ids.slice(0, 2), ids.slice(2)].map((part, index) => ({
        ...base, ts: index + 1, name: 'ProfileChunk', args: { data: {
            cpuProfile: { nodes: [], samples: [1] }, timeDeltas: [10], allocationSampleIds: [part[part.length - 1]],
            allocationSamples: { ids: part, sizes: part.map(() => 8), types: part.map(() => 1), typesDict: { 1: 'OBJECT' } },
            allocationGc: { 5: part }
        } }
    }));
    const input = [
        { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
        ...chunks,
        { ...base, name: 'Compile', ph: 'X', cat: 'disabled-by-default-v8.compilation_allocations', dur: 1,
            args: { data: { scriptId: 1, start: 0, startAllocationId: 9, endAllocationId: 12 } } }
    ];
    const before = structuredClone(input);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const session = extractFromChromiumPerformanceProfile(input);
        const profile = session.profiles[0];

        assert.deepEqual(profile.samples, [1, 1]);
        assert.deepEqual(profile.timeDeltas, [10, 10]);
        assert.deepEqual(Object.keys(profile).filter(key => key.startsWith('_cpuproAllocation')), []);
        assert.equal(session.threads[0].compilations!.length, 1);
        assert.deepEqual(warning.mock.calls, [['Ignoring allocation data with unsorted IDs', { pid: 1, tid: 2 }]]);
        assert.deepEqual(input, before);
    } finally {
        warning.mockRestore();
    }
});

test.each([{ ids: [10, 11, 12] }, { ids: [10, 12, 15] }, { ids: [10, 12, 11] }])('combined cpuprofile checks allocation order before publishing vectors: $ids', ({ ids }) => {
    const input = {
        startTime: 0, endTime: 20, samples: [], timeDeltas: [], nodes: [],
        cpuProfile: { samples: [1, 1], timeDeltas: [10, 10], nodes: [] },
        allocationSampleIds: [10, 15],
        allocationSamples: { ids, sizes: [8, 16, 32], types: [1, 2, 3], gc: [0, 1, 2], typesDict: { 1: 'OBJECT' } }
    };
    const before = structuredClone(input);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const profile = unwrapSamplesIfNeeded(input);

        assert.equal(profile.samples, input.cpuProfile.samples);
        assert.equal(profile.timeDeltas, input.cpuProfile.timeDeltas);
        if (ids[2] === 11) {
            assert.deepEqual(Object.keys(profile).filter(key => key.startsWith('_cpuproAllocation')), []);
            assert.deepEqual(warning.mock.calls, [['Ignoring allocation data with unsorted IDs']]);
        } else {
            assert.equal(profile._cpuproAllocationIds, ids);
            assert.equal(profile._cpuproAllocationIdsOrder, ids[1] === 11 ? 'consecutive' : 'ascending');
            assert.equal(profile._cpuproAllocationSizes, input.allocationSamples.sizes);
            assert.equal(profile._cpuproAllocationTypes, input.allocationSamples.types);
            assert.equal(profile._cpuproAllocationGc, input.allocationSamples.gc);
            assert.equal(warning.mock.calls.length, 0);
        }
        assert.deepEqual(input, before);
    } finally {
        warning.mockRestore();
    }
});

test('numeric order classifies arrays and typed arrays without mutation', () => {
    const cases = [
        { values: [], order: 'consecutive' },
        { values: [10], order: 'consecutive' },
        { values: [-2, -1, 0], order: 'consecutive' },
        { values: [0.5, 1.5, 2.5], order: 'consecutive' },
        { values: [10, 12, 15], order: 'ascending' },
        { values: [10, 10, 11], order: 'ascending' },
        { values: [10, 12, 11], order: 'unordered' }
    ];

    for (const { values, order } of cases) {
        const array = Object.freeze(values.slice());
        const typed = Float64Array.from(values);

        assert.equal(getNumericArrayOrder(array), order);
        assert.equal(getNumericArrayOrder(typed), order);
        assert.deepEqual(Array.from(typed), values);
    }
});

test('numeric order reads each element once and stops at the first inversion', () => {
    for (const values of [[10, 11, 12, 13], [10, 12, 12, 20], [10, 9, 20, 30]]) {
        const reads: string[] = [];
        const input = new Proxy(values, {
            get(target, property) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    reads.push(property);
                }

                return Reflect.get(target, property, target);
            }
        });

        getNumericArrayOrder(input);

        assert.deepEqual(reads, values[1] < values[0] ? ['0', '1'] : ['0', '1', '2', '3']);
    }
});

test('CPU chunks retain node order and merge trace ids', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
    const first = { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 } };
    const second = { ...first, id: 2 };
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
        { ...base, name: 'ProfileChunk', args: { data: { cpuProfile: { nodes: [first], trace_ids: { first: 1 } } } } },
        { ...base, name: 'ProfileChunk', args: { data: {} } },
        { ...base, name: 'ProfileChunk', args: { data: { cpuProfile: { nodes: [second], trace_ids: { second: 2 } } } } }
    ]);

    assert.deepEqual(session.profiles[0].nodes, [first, second]);
    assert.deepEqual(session.profiles[0].trace_ids, { first: 1, second: 2 });
});

function extractScriptCatchups(catchups: { name?: string; pid?: number; tid?: number; data: Record<string, unknown> }[]) {
    const base = { pid: 1, tid: 2, ts: 0, ph: 'X', cat: 'disabled-by-default-v8.source' };

    return extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', ph: 'P', id: '1', args: { data: { startTime: 0 } } },
        ...catchups.map(({ name = 'ScriptCatchup', pid = 1, tid = 2, data }, index) => ({
            ...base, name, pid, tid, ts: index + 1, args: { data }
        })).reverse()
    ]);
}

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
    const session = extractScriptCatchups([
        { data: { scriptId: 5, sourceText: 'complete' } },
        { name: 'LargeScriptCatchup', data }
    ]);

    assert.equal(session.threads[0].scripts![0].source, 'complete');
    assert.equal(data.sourceText, 'partial');
});
