import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { findView } from '../../test/helpers/view-config.js';

let page;

evaluateModule(new URL('./events.js', import.meta.url), {
    discovery: {
        page: { define(name, config) {
            assert.equal(name, 'events');
            page = config;
        } }
    }
});

const query = jora.setup({ methods });
const propQuery = value => query(value.slice(1));
const contentQuery = content => query(content.slice(content.indexOf(':') + 1));
const prepare = query(page.content.data);
const eventsTimeline = methods.eventsTimeline;
const processSelect = findView(page, { name: 'pageProcess' });
const intervalSelect = findView(page, { name: 'intervals' });
const spanValues = findView(page, { view: 'labeled-value-list' });

test('the process selector lists processes by name, labeled by the name or as a process', () => {
    const processes = [{ name: 'Renderer', pid: 2 }, { name: 'Browser', pid: 1 }];
    const label = contentQuery(processSelect.item);

    assert.deepEqual(query(processSelect.data)({ defaultSession: { processes } }), [processes[1], processes[0]]);
    assert.equal(label({ value: processes[1] }), 'Browser (pid:1)');
    assert.equal(label({ value: { pid: 3 } }), 'Process  (pid:3)');
});

test('intervals of garbage collections are selected at first, an interval is labeled by its text or name', () => {
    const checked = propQuery(intervalSelect.checkbox.checked);
    const label = contentQuery(intervalSelect.checkbox.content);

    // Options of the page are evaluated in another realm
    assert.deepEqual(Array.from(intervalSelect.data, interval => [label(interval), checked(interval)]), [
        ['MinorGC', true],
        ['MajorGC', true],
        ['Layout', false],
        ['UpdateLayoutTree', false],
        ['Paint', false],
        ['Recalculate Styles', false]
    ]);
});

test('a span tooltip shows the duration, start and end of the span', () => {
    const values = query(spanValues.data)({ start: 10, end: 25 }, { spanStart: 1010, spanEnd: 1025 });

    assert.deepEqual(values, [
        { text: 'Duration', value: 15 },
        { text: 'Start', value: 1010 },
        { text: 'End', value: 1025 }
    ]);
});

test('threads with events or profiles go in priority order, then by name and by event count', () => {
    const event = { tm: 10, duration: 1, name: 'Task' };
    // Frozen: the own order of the process threads is kept
    const threads = Object.freeze([
        {
            name: 'Worker 2',
            pid: 1,
            tid: 1,
            events: [event]
        },
        {
            name: 'Worker 10',
            pid: 1,
            tid: 2,
            events: [event]
        },
        {
            name: 'DedicatedWorker thread',
            pid: 1,
            tid: 3,
            events: [event]
        },
        {
            name: 'Compositor',
            pid: 1,
            tid: 4,
            events: [event]
        },
        {
            name: 'CrRendererMain',
            pid: 1,
            tid: 5,
            events: [event]
        },
        {
            name: 'Worker 2',
            pid: 1,
            tid: 6,
            events: [event, event]
        },
        {
            name: 'Worker 2',
            pid: 1,
            tid: 7,
            events: [event]
        },
        {
            name: 'Profiles',
            pid: 1,
            tid: 8,
            profiles: [{}]
        },
        {
            name: 'Empty',
            pid: 1,
            tid: 9,
            events: [],
            profiles: []
        }
    ]);
    const result = prepare(null, { pageProcess: { threads }, intervals: [] });

    assert.deepEqual(result.spans.map(group => group.name), [
        'CrRendererMain (pid:1 tid:5)',
        'DedicatedWorker thread (pid:1 tid:3)',
        'Compositor (pid:1 tid:4)',
        'Profiles (pid:1 tid:8)',
        'Worker 10 (pid:1 tid:2)',
        'Worker 2 (pid:1 tid:6)',
        'Worker 2 (pid:1 tid:1)',
        'Worker 2 (pid:1 tid:7)'
    ]);
});

test('the page passes the ordered threads and the interval selection to the method once', () => {
    const event = { tm: 10, duration: 5, name: 'MinorGC' };
    const worker = { name: 'Worker', events: [event] };
    const renderer = { name: 'CrRendererMain', events: [event] };
    const threads = [worker, { name: 'Empty', events: [], profiles: [] }, renderer];
    const intervals = [{ name: 'MinorGC', color: '#123' }];
    const calls = [];
    const eventsTimelineSpy = (input, selection) => {
        calls.push([input, selection]);

        return eventsTimeline(input, selection);
    };
    const query = jora.setup({ methods: { ...methods, eventsTimeline: eventsTimelineSpy } })(page.content.data);
    const result = query(null, { pageProcess: { threads }, intervals });

    assert.equal(calls.length, 1);

    const [input, selection] = calls[0];

    assert.equal(input.length, 2);
    assert.equal(input[0], renderer);
    assert.equal(input[1], worker);
    assert.equal(selection, intervals);
    assert.equal(result.spans[0].spans[0].event, event);
    assert.equal(result.spans[1].intervals[0].color, '#123');
});

test('a changed interval selection of the same process is evaluated afresh', () => {
    const pageProcess = {
        threads: [{ name: 'T', events: [{ tm: 10, duration: 5, name: 'MinorGC' }] }]
    };
    const colors = intervals => prepare(null, { pageProcess, intervals }).spans[0].intervals.map(entry => entry.color);

    assert.deepEqual(colors([{ name: 'MinorGC', color: '#123' }]), ['#123']);
    assert.deepEqual(colors([]), []);
    assert.deepEqual(colors([{ name: 'MinorGC', color: '#456' }]), ['#456']);
});

test.each([
    ['no process', {}],
    ['a process without threads', { pageProcess: {} }],
    ['a process of no threads', { pageProcess: { threads: [] } }]
])('a page of %s has no groups and no bounds', (_, context) => {
    assert.deepEqual(prepare(null, context), { spans: [], minX: undefined, maxX: NaN });
});

test('a thread without events is an empty group named by the thread and its process', () => {
    const threads = [{ name: 'Profiles', pid: 1, tid: 2, profiles: [{}] }];

    assert.deepEqual(eventsTimeline(threads), {
        spans: [{ name: 'Profiles (pid:1 tid:2)', spans: [], intervals: [] }],
        minX: undefined,
        maxX: NaN
    });
});

test('spans are the events of a positive time and duration except animations', () => {
    const events = [
        { tm: 0, duration: 10, name: 'Task' },
        { tm: -10, duration: 20, name: 'Task' },
        { tm: 10, duration: 0, name: 'Task' },
        { tm: 11, duration: -1, name: 'Task' },
        { tm: 1, duration: 1000, name: 'Animation' },
        { tm: 20, duration: 5, name: 'Task' },
        { tm: 40.25, duration: 0.5, name: 'MinorGC' }
    ];
    const [group] = eventsTimeline([{ name: 'T', events }]).spans;

    assert.deepEqual(group.spans, [
        { start: 20, end: 25, text: 'Task', event: events[5] },
        { start: 40.25, end: 40.75, text: 'MinorGC', event: events[6] }
    ]);
});

test('a span refers to its event, a repeated event makes a span of each occurrence', () => {
    const event = { tm: 1, duration: 2, name: 'Task' };
    const [group] = eventsTimeline([{ name: 'T', events: [event, event] }]).spans;

    assert.equal(group.spans.length, 2);
    assert.equal(group.spans[0].event, event);
    assert.equal(group.spans[1].event, event);
});

test('a span of an event dispatch names the type of the event', () => {
    const event = { tm: 20, duration: 5, name: 'EventDispatch', data: { type: 'click' } };
    const [group] = eventsTimeline([{ name: 'T', events: [event] }]).spans;

    assert.equal(group.spans[0].text, 'EventDispatch / click');
});

test('interval overlays are all events of the selected names, colored by the last selection of a name', () => {
    const events = [
        { tm: 0, duration: 10, name: 'MinorGC' },
        { tm: -10, duration: 20, name: 'MinorGC' },
        { tm: 12, duration: -2, name: 'MinorGC' },
        { tm: 20, duration: 5, name: 'Task' },
        { tm: 30, duration: 4, name: 'MajorGC' },
        { tm: 40, duration: 1, name: 'Layout' }
    ];
    const selection = [
        { name: 'MinorGC', color: '#123' },
        { name: 'MajorGC', color: '#456' },
        { name: 'MinorGC', color: '#789' },
        { name: 'Layout', color: '' }
    ];
    const [group] = eventsTimeline([{ name: 'T', events }], selection).spans;

    assert.deepEqual(group.intervals, [
        { start: 0, end: 10, text: 'MinorGC', color: '#789' },
        { start: -10, end: 10, text: 'MinorGC', color: '#789' },
        { start: 12, end: 10, text: 'MinorGC', color: '#789' },
        { start: 30, end: 34, text: 'MajorGC', color: '#456' }
    ]);
});

test('bounds span the events of a positive time of all threads, also those without spans', () => {
    const first = [
        { tm: 30, duration: 5, name: 'Task' },
        { tm: 0, duration: 3000, name: 'Task' },
        { tm: -5, duration: 3000, name: 'Task' }
    ];
    const second = [
        { tm: 10, duration: 0, name: 'Task' },
        { tm: 1500, duration: -2, name: 'Task' },
        { tm: 2000, duration: -1, name: 'Task' },
        { tm: 20, duration: 1000, name: 'Animation' }
    ];
    const result = eventsTimeline([{ name: 'A', events: first }, { name: 'B', events: second }]);

    // An incomplete event, of a duration of -1, has no end
    assert.deepEqual([result.minX, result.maxX], [10, 1498]);
});

test.each([
    ['no events of a positive time', { tm: 0, duration: 5, name: 'Task' }, undefined],
    ['only incomplete events', { tm: 4, duration: -1, name: 'Task' }, 4]
])('bounds of %s have no end', (_, event, minX) => {
    const result = eventsTimeline([{ name: 'T', events: [event] }]);

    assert.deepEqual([result.minX, result.maxX], [minX, NaN]);
});

// The bulk query the page used before the method, an independent reference for a real trace
const referenceQuery = jora(`
    $threadOrder: ['CrRendererMain', 'DedicatedWorker thread', 'Compositor'].reverse();
    #.pageProcess.threads
        .[events or profiles]
        .sort($threadOrder.indexOf(name) desc, name asc, events.size() desc)
    | {
        $intervals: {...#.intervals.({ key: name, value: color }).fromEntries()};

        spans: .({
            name: \`\${name} (pid:\${pid} tid:\${tid})\`,
            spans: events.[tm > 0 and duration > 0 and name != "Animation"].({
                start: tm,
                end: tm + duration,
                text: name + (name = 'EventDispatch' ? ' / ' + data.type : ''),
                event: $
            }),
            intervals: events.[$intervals[name]].({
                start: tm,
                end: tm + duration,
                text: name,
                color: $intervals[name]
            })
        }),
        minX: events.[tm > 0].tm.min(),
        maxX: events.[tm > 0 and duration != -1].(tm + duration).max()
    }
`);

const traceFixture = process.env.CPUPRO_TRACK_TIMELINE_FIXTURE;

test.skipIf(!traceFixture)('events of a real trace match the previous query', { timeout: 60000 }, () => {
    const fixture = JSON.parse(readFileSync(traceFixture, 'utf8'));
    const threads = [];

    for (let i = 0; i < fixture.length; i++) {
        const thread = fixture[i];
        const events = [];

        for (let j = 0; j < thread.events.length; j++) {
            const event = thread.events[j];

            events.push({
                name: event.name,
                tm: event.start,
                duration: event.end - event.start
            });
        }

        threads.push({
            name: thread.name,
            pid: 1,
            tid: thread.tid,
            profiles: [],
            events
        });
    }

    for (const intervals of [[], [{ name: 'MinorGC', color: '#123' }, { name: 'MajorGC', color: '#456' }]]) {
        const context = { pageProcess: { threads }, intervals };

        assert.deepEqual(prepare(null, context), referenceQuery(null, context));
    }
});
