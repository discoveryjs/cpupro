import assert from 'node:assert/strict';
import { test } from 'vitest';
import { extractFromChromiumPerformanceProfile } from './chromium-performance-profile.js';

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
        { ...base, name: 'Unrelated', cat: 'other', ph: 'I', ts: 30, args: {} }
    ];
    const session = extractFromChromiumPerformanceProfile(traceEvents);
    const events = session.threads[0].events;

    assert.deepEqual(events.map(event => ({ name: event.name, cat: event.cat, tm: event.tm, duration: event.duration })), [
        { name: 'CompileCode', cat: category, tm: 10, duration: 15 },
        { name: 'CompileFunction', cat: category, tm: 20, duration: 0 }
    ]);
    assert.equal(events[0].data, completeArgs);
    assert.equal(events[1].data, instantArgs);
    assert.deepEqual(instantArgs.data, { ...data, startAllocationId: 8454 });
    assert.deepEqual(traceEvents.map(event => event.ts), [0, 20, 10, 30]);
    assert.equal(session.threads[0].userTimings.length, 0);
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
