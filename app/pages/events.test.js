import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';

let page;

runInNewContext(readFileSync(new URL('./events.js', import.meta.url), 'utf8'), {
    discovery: {
        page: { define(name, config) {
            assert.equal(name, 'events');
            page = config;
        } }
    }
});

assert.equal(typeof page.content.data, 'string');
const prepare = jora.setup({ methods })(page.content.data);

const reference = jora(`
    $threadOrder: ['CrRendererMain', 'DedicatedWorker thread', 'Compositor'].reverse();
    #.pageProcess.threads
        .[events or profiles]
        .sort($threadOrder.indexOf(name) desc, name asc, events.size() desc)
    | {
        $minX: events.[tm>0].tm.min();
        $maxX: events.[tm>0 and duration!=-1].(tm + duration).max();
        $cutMin: => $ - 0;
        $intervals: {...#.intervals.({ key: name, value: color }).fromEntries()};
        $spans: .({
            name: \`\${name} (pid:\${pid} tid:\${tid})\`,
            spans: events.[tm > 0 and duration > 0 and name!="Animation"].({
                start: tm | $cutMin(),
                end: tm + duration | $cutMin(),
                text: name + (name = 'EventDispatch' ? ' / ' + data.type : ''),
                event: $
            }),
            intervals: events.[$intervals[name]].({
                start: tm | $cutMin(),
                end: tm + duration | $cutMin(),
                text: name,
                color: $intervals[name] or "#00000038"
            }) + (profiles[] | $ ? [] : [])
        });
        spans: $spans,
        $minX,
        maxX: $maxX | $cutMin()
    }
`);

function assertPrepared(pageProcess, intervals = []) {
    const context = { pageProcess, intervals };
    const expected = reference(null, context);
    const actual = prepare(null, context);

    expected.spans ||= [];
    for (const group of expected.spans) {
        group.spans ||= [];
        group.intervals = (group.intervals || []).filter(interval => interval !== undefined);
    }

    assert.deepEqual(structuredClone(actual), structuredClone(expected));
    for (let groupIndex = 0; groupIndex < expected.spans.length; groupIndex++) {
        const group = expected.spans[groupIndex];
        group.spans.forEach((span, index) => assert.equal(actual.spans[groupIndex].spans[index].event, span.event));
    }

    return actual;
}

test('events preparation preserves query filters, bounds, interval overlays and event identity', () => {
    const events = Object.freeze([
        { tm: 0, duration: 10, name: 'MinorGC' },
        { tm: -10, duration: 20, name: 'MinorGC' },
        { tm: 10, duration: 0, name: 'MinorGC' },
        { tm: 11, duration: -1, name: 'MinorGC' },
        { tm: 12, duration: -2, name: 'MinorGC' },
        { tm: 1, duration: 1000, name: 'Animation' },
        { tm: 20, duration: 5, name: 'EventDispatch', data: { type: 'click' } },
        { tm: 30, duration: 5, name: 'EventDispatch' },
        { tm: 40, duration: 2, name: 'MinorGC' }
    ].map(Object.freeze));
    const process = Object.freeze({ threads: Object.freeze([
        Object.freeze({ name: 'CrRendererMain', pid: 1, tid: 2, events })
    ]) });
    const actual = assertPrepared(process, [{ name: 'MinorGC', color: '#123' }]);

    assert.equal(actual.minX, 1);
    assert.equal(actual.maxX, 1001);
    assert.equal(actual.spans[0].spans.length, 3);
    assert.equal(actual.spans[0].intervals.length, 6);
});

test('events preparation preserves thread priority, name order, count ties and profile-only groups', () => {
    const event = { tm: 10, duration: 1, name: 'Task' };
    const threads = [
        { name: 'Worker 2', tid: 1, events: [event] },
        { name: 'Worker 10', tid: 2, events: [event] },
        { name: 'DedicatedWorker thread', tid: 3, events: [event] },
        { name: 'Compositor', tid: 4, events: [event] },
        { name: 'CrRendererMain', tid: 5, events: [event] },
        { name: 'Worker 2', tid: 6, events: [event, { ...event }] },
        { name: 'Worker 2', tid: 7, events: [event] },
        { name: 'Profiles', tid: 8, profiles: [{}] },
        { name: 'Empty', tid: 9, events: [], profiles: [] }
    ].map(thread => Object.freeze({ pid: 10, ...thread }));
    const original = threads.slice();
    assertPrepared({ threads: Object.freeze(threads) });
    assert.deepEqual(threads, original);
});

test('events preparation handles empty inputs, absent selection and no eligible bounds', () => {
    for (const process of [undefined, {}, { threads: [] }, { threads: [{ name: 'Profiles', profiles: [{}] }] }, {
        threads: [{ name: 'T', events: [{ tm: 4, duration: -1, name: 'Task' }] }]
    }]) {
        assertPrepared(process);
    }
    assert.equal(prepare(null, {}).spans.length, 0);
});

test('page query passes ordered threads and interval selection to the registered method once', () => {
    const event = { tm: 10, duration: 5, name: 'MinorGC' };
    const worker = { name: 'Worker', events: [event] };
    const renderer = { name: 'CrRendererMain', events: [event] };
    const threads = Object.freeze([worker, { name: 'Empty', events: [], profiles: [] }, renderer]);
    const intervals = Object.freeze([{ name: 'MinorGC', color: '#123' }]);
    const calls = [];
    const query = jora.setup({ methods: {
        ...methods,
        eventsTimeline(input, selection) {
            calls.push({ input, selection });
            return methods.eventsTimeline(input, selection);
        }
    } })(page.content.data);
    const result = query(null, { pageProcess: { threads }, intervals });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, [renderer, worker]);
    assert.equal(calls[0].input[0], renderer);
    assert.equal(calls[0].input[1], worker);
    assert.equal(calls[0].selection, intervals);
    assert.equal(result.spans[0].spans[0].event, event);
    assert.equal(result.spans[1].intervals[0].color, '#123');
});

test('interval selection updates do not leak across calls or processes', () => {
    const process = { threads: [{ name: 'T', events: [{ tm: 10, duration: 5, name: 'MinorGC' }] }] };
    assertPrepared(process, [{ name: 'MinorGC', color: '#123' }, { name: 'MinorGC', color: '#456' }]);
    assertPrepared(process, []);
    assertPrepared(process, [{ name: 'MinorGC', color: '' }]);
    assertPrepared({ threads: [{ name: 'Other', events: [{ tm: 100, duration: 7, name: 'Task' }] }] });
});

test('events preparation keeps repeated input occurrences and fractional coordinates', () => {
    const event = Object.freeze({ tm: 1.25, duration: 0.001, name: 'MinorGC' });
    const process = { threads: [{ name: 'T', events: [event, event, { ...event }] }] };
    const actual = assertPrepared(process, [{ name: 'MinorGC', color: '#123' }]);

    assert.equal(actual.spans[0].spans.length, 3);
    assert.equal(actual.spans[0].spans[0].event, event);
    assert.equal(actual.spans[0].spans[1].event, event);
});

test.skipIf(!process.env.CPUPRO_TRACK_TIMELINE_FIXTURE)('events preparation matches the real trace query', { timeout: 60000 }, () => {
    const fixture = JSON.parse(readFileSync(process.env.CPUPRO_TRACK_TIMELINE_FIXTURE, 'utf8'));
    const processData = { threads: fixture.map(thread => ({
        name: thread.name,
        tid: thread.tid,
        pid: 2576,
        profiles: [],
        events: thread.events.map(event => ({
            name: event.name,
            tm: event.start,
            duration: event.end - event.start
        }))
    })) };

    assertPrepared(processData, [{ name: 'MinorGC', color: '#f7b26b38' }, { name: 'MajorGC', color: '#f78c6b38' }]);
    assertPrepared(processData, []);
});
