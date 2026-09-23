import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { extractFromChromiumPerformanceProfile } from './chromium-performance-profile.js';
import { collectProfileUsedScriptIds } from '../preprocessing/scripts.js';
import { getNumericArrayOrder } from '../computations/misc.js';

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
    assert.equal(session.profiles[0]._events, events);
    assert.deepEqual([...collectProfileUsedScriptIds(session.profiles[0])], [5]);
});

test('allocation order is shared by GC mapping and compilation preparation', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        for (const ids of [[10, 11, 12], [10, 12, 15], [15, 10, 12]]) {
            warning.mockClear();

            const session = extractFromChromiumPerformanceProfile([
                { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
                { ...base, name: 'ProfileChunk', args: { data: {
                    allocationSamples: { ids, sizes: [8, 16, 32] },
                    allocationGc: { 5: [10, 12, 99] }
                } } }
            ]);
            const profile = session.profiles[0];
            const order = ids[1] === 11 ? 'consecutive' : ids[0] === 10 ? 'ascending' : 'unordered';

            assert.equal(profile._cpuproAllocationIdsOrder, order);
            assert.deepEqual(profile._cpuproAllocationIds, ids);
            assert.deepEqual(profile._cpuproAllocationGc, ids.map(id => id === 10 || id === 12 ? 5 : 0));
            assert.equal(warning.mock.calls.length, order === 'consecutive' ? 0 : 1);
        }
    } finally {
        warning.mockRestore();
    }
});

test('format-local order classification matches the numeric contract', () => {
    const base = { pid: 1, tid: 2, ts: 0, cat: 'profile', ph: 'P', id: '1' };
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
        const session = extractFromChromiumPerformanceProfile([
            { ...base, name: 'Profile', args: { data: { startTime: 0 } } },
            { ...base, name: 'ProfileChunk', args: { data: { allocationSamples: { ids: values } } } }
        ]);

        assert.equal(getNumericArrayOrder(values), order);
        assert.equal(getNumericArrayOrder(Float64Array.from(values)), order);
        assert.equal(session.profiles[0]._cpuproAllocationIdsOrder, values.length ? order : undefined);
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
