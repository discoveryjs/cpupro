import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import jora from 'jora';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';
import { findView, findViews } from '../../../test/helpers/view-config.js';
import { methods } from '../../jora/index.mjs';
import { signalWindows, signalMeasurements, compilationPopulation, signalScopes, signalScopeLabel } from '../../signals.js';
import { correlations } from './correlations.js';

type Measurement = { value: number | null; of?: number };

const query = jora.setup({ methods });
// Queries of a `=query` property and of a `<view>:query` content
const propQuery = (value: string) => query(value.slice(1));
const contentQuery = (content: string) => query(content.slice(content.indexOf(':') + 1));

// Values of the measurement rows shown for the scope, by their titles
function measure(scope: unknown) {
    const rows: Record<string, Measurement> = {};

    for (let i = 0; i < signalMeasurements.length; i++) {
        const { title, when, data } = signalMeasurements[i];

        if (query(when)(scope, {})) {
            rows[title] = query(data)(scope, {});
        }
    }

    return rows;
}

const event = { tm: 105, duration: 10, allocationStart: 1, allocationEnd: 3 };

// A scope of 3 CPU samples over 100-140us, optionally with 4 allocations and with the event
async function createScope(signals: { allocations?: boolean; events?: boolean }) {
    const { profile } = await createProfileFixture({ startTime: 100, cpuOnly: !signals.allocations });

    if (signals.events) {
        profile.thread = { compilations: [event] } as unknown as typeof profile.thread;
    }

    return profile;
}

describe('scopes', () => {
    test('include event-only threads without borrowing a sampled profile', () => {
        const profile = { timeline: {}, thread: { tid: 1 } };
        const eventThread = { tid: 2, profiles: [], compilations: [{ name: 'Compile' }] };
        const data = {
            profiles: [profile],
            defaultSession: { processes: [{ threads: [
                { profiles: [profile], compilations: [{ name: 'Compile' }] }, eventThread
            ] }] }
        };

        assert.deepEqual(query(signalScopes)(data), [profile, { thread: eventThread }]);
        assert.deepEqual(query(signalScopes)({}), [{}]);
    });

    test.each([
        [
            'the thread name and ids',
            { name: 'Profile 1', thread: { name: 'Worker', pid: 1, tid: 0 } },
            'Worker pid:1 tid:0'
        ],
        ['the profile name without a thread name', { name: 'Profile 1', thread: { tid: 2 } }, 'Profile 1 tid:2'],
        ['a placeholder without names', {}, 'Profile']
    ])('are labeled by %s', (_, scope, label) => {
        assert.equal(query(signalScopeLabel)(scope), label);
    });
});

test('event durations are summed and maximized over the timed and instant events they are counted as', () => {
    const compilations = [
        { name: 'Parse', tm: 5, duration: -3 },
        { name: 'Parse', tm: 6, duration: -1 },
        { name: 'Compile', tm: 10, duration: 30 },
        { name: 'Compile', tm: null, duration: 100 },
        { name: 'Compile', tm: 20, duration: 0 },
        { name: 'Compile', tm: 30, duration: null },
        { name: 'Instant', tm: 40, duration: 0 }
    ];
    const profile = {
        thread: {
            compilations
        }
    };

    // a negative duration or an event without a start is unfinished and has no known duration
    assert.deepEqual(query(compilationPopulation)(profile), [
        {
            name: 'Compile',
            count: 4,
            timed: 1,
            instant: 1,
            unfinished: 2,
            duration: 30,
            maxDuration: 30,
            first: 10,
            last: 40
        },
        {
            name: 'Parse',
            count: 2,
            timed: 0,
            instant: 0,
            unfinished: 2,
            duration: 0,
            maxDuration: undefined,
            first: 5,
            last: 6
        },
        {
            name: 'Instant',
            count: 1,
            timed: 0,
            instant: 1,
            unfinished: 0,
            duration: 0,
            maxDuration: 0,
            first: 40,
            last: 40
        }
    ]);
});

test('compilation events are grouped by name with their counts, durations and time bounds', () => {
    const scope = {
        thread: {
            compilations: [
                { name: 'Compile', tm: 10, duration: 30 },
                { name: 'Parse', tm: 5, duration: -1 },
                { name: 'Compile', tm: 20, duration: 0 },
                { name: 'Compile', tm: 30, duration: null },
                { name: 'Parse', tm: 50, duration: 4 }
            ]
        }
    };

    assert.deepEqual(query(compilationPopulation)(scope), [
        {
            name: 'Compile',
            count: 3,
            timed: 1,
            instant: 1,
            unfinished: 1,
            duration: 30,
            maxDuration: 30,
            first: 10,
            last: 40
        },
        {
            name: 'Parse',
            count: 2,
            timed: 1,
            instant: 0,
            unfinished: 1,
            duration: 4,
            maxDuration: 4,
            first: 5,
            last: 54
        }
    ]);
    assert.deepEqual(query(compilationPopulation)({}), []);
});

describe('windows', () => {
    // Time is relative to the start of the axis, ids are allocation ids
    test.each([
        ['no signals', () => ({}), [
            { title: 'CPU samples', count: undefined, time: null, ids: null },
            { title: 'Allocations', count: undefined, time: null, ids: null },
            { title: 'Compilation events', count: 0, time: null, ids: null }
        ]],
        ['CPU samples', () => createScope({}), [
            { title: 'CPU samples', count: 3, time: { start: 10, end: 40 }, ids: null },
            { title: 'Allocations', count: undefined, time: null, ids: null },
            { title: 'Compilation events', count: 0, time: null, ids: null }
        ]],
        ['CPU samples, allocations and events', () => createScope({ allocations: true, events: true }), [
            { title: 'CPU samples', count: 3, time: { start: 10, end: 40 }, ids: { start: 1, end: 4 } },
            { title: 'Allocations', count: 4, time: null, ids: { start: 0, end: 4 } },
            { title: 'Compilation events', count: 1, time: { start: 5, end: 15 }, ids: { start: 1, end: 3 } }
        ]]
    ])('of a scope with %s', async (_, create, windows) => {
        assert.deepEqual(query(signalWindows)(await create(), {}), windows);
    });

    test('of events use events with a start on the time axis and with a non-empty range on ids', () => {
        const scope = {
            thread: {
                compilations: [
                    { tm: 10, duration: 5, allocationStart: 2, allocationEnd: 4 },
                    { tm: 20, duration: 0, allocationStart: 0, allocationEnd: 0 },
                    { tm: null, duration: null, allocationStart: 1, allocationEnd: 9 },
                    { tm: 30, duration: 10, allocationStart: null, allocationEnd: null },
                    { tm: null, duration: null, allocationStart: null, allocationEnd: 50 }
                ]
            }
        };

        assert.deepEqual(query(signalWindows)(scope, {})[2], {
            title: 'Compilation events',
            count: 5,
            time: { start: 10, end: 40 },
            ids: { start: 1, end: 9 }
        });
    });
});

describe('measurements', () => {
    // Titles of the rows by the signals they need
    const cpuRows = [
        'Time before the first sample',
        'Time after the last sample',
        'Sample deltas longer than 2.5 intervals',
        'Time in sample deltas longer than 2.5 intervals'
    ];
    const allocationRows = [
        'Inversions of the mapping allocation -> sample',
        'Inversions of the mapping sample -> allocation',
        'Allocations before the first sample',
        'Allocations after the last sample'
    ];
    const eventRows = [
        'Events without duration',
        'Events covering at least one allocation',
        'Events with an inverted allocation range',
        'Events partially overlapping in time',
        'Allocation range outside of the time parent range'
    ];
    const eventAxisRows = [
        'Events starting before the sample time axis',
        'Events starting after the sample time axis',
        'The furthest event start from the sample time axis'
    ];

    test.each([
        ['no signals', () => ({}), []],
        ['events only', () => ({ thread: { compilations: [event] } }), eventRows],
        ['CPU samples', () => createScope({}), cpuRows],
        ['CPU samples and events', () => createScope({ events: true }), [...cpuRows, ...eventRows, ...eventAxisRows]],
        ['CPU samples and allocations', () => createScope({ allocations: true }), [...cpuRows, ...allocationRows]],
        ['CPU samples, allocations and events', () => createScope({ allocations: true, events: true }), [
            ...cpuRows, ...allocationRows, ...eventRows, ...eventAxisRows, 'Allocations with a stage of another event'
        ]]
    ])('of a scope with %s', async (_, create, titles) => {
        assert.deepEqual(Object.keys(measure(await create())), titles);
    });

    test('of CPU samples read the axis margins and count deltas longer than 2.5 intervals', async () => {
        // samples every 10us, so a delta of 25us is not longer
        const { profile } = await createLineFixture({ before: 7, after: 3, values: new Uint32Array([10, 25, 30]) });

        assert.deepEqual(measure(profile), {
            'Time before the first sample': { value: 7 },
            'Time after the last sample': { value: 3 },
            'Sample deltas longer than 2.5 intervals': { value: 1, of: 3 },
            'Time in sample deltas longer than 2.5 intervals': { value: 30, of: 65 }
        });
    });

    test('count inversions of each mapping direction', async () => {
        const { profile } = await createProfileFixture();

        profile.timeline!.mappings.memline._mapping[1] = 0;

        const rows = measure(profile);

        assert.deepEqual(rows['Inversions of the mapping sample -> allocation'], { value: 1, of: 3 });
        assert.deepEqual(rows['Inversions of the mapping allocation -> sample'], { value: 0, of: 4 });
    });

    // Samples are mapped to allocation ids of 4 allocations
    test.each([
        ['inside of the stream', [1, 2, 3], { value: 1, of: 4 }, { value: 1, of: 4 }],
        ['covering the whole stream', [0, 2, 4], { value: 0, of: 4 }, { value: 0, of: 4 }],
        ['exceeding the stream', [1, 3, 9], { value: null, of: 4 }, { value: null, of: 4 }],
        ['going backwards', [1, 0, 4], { value: null, of: 4 }, { value: null, of: 4 }]
    ])('count allocations outside of samples mapped %s', async (_, mapping, before, after) => {
        const { profile } = await createProfileFixture({ mapping });
        const rows = measure(profile);

        assert.deepEqual(rows['Allocations before the first sample'], before);
        assert.deepEqual(rows['Allocations after the last sample'], after);
    });

    test('count events by duration and allocation range', () => {
        const rows = measure({
            thread: {
                compilations: [
                    { tm: 0, duration: 10, allocationStart: 0, allocationEnd: 3 },
                    { tm: 0, duration: 5, allocationStart: 2, allocationEnd: 2 },
                    { tm: 6, duration: 2, allocationStart: 3, allocationEnd: 1 },
                    { tm: 9, duration: 0, allocationStart: 0, allocationEnd: 1 },
                    { tm: 0, duration: 1, allocationStart: null, allocationEnd: null },
                    { tm: null, duration: null, allocationStart: null, allocationEnd: 5 }
                ]
            }
        });

        assert.deepEqual(rows['Events without duration'], { value: 2, of: 6 });
        assert.deepEqual(rows['Events covering at least one allocation'], { value: 2, of: 6 });
        assert.deepEqual(rows['Events with an inverted allocation range'], { value: 1, of: 6 });
    });

    test('read partial overlaps and allocation ranges outside of the parent from the nesting of events', () => {
        const rows = measure({
            thread: {
                compilations: [
                    { tm: 10, duration: 30, allocationStart: 10, allocationEnd: 20 },
                    { tm: 20, duration: 30, allocationStart: 15, allocationEnd: 25 }
                ]
            }
        });

        assert.deepEqual(rows['Events partially overlapping in time'], { value: 1, of: 2 });
        assert.deepEqual(rows['Allocation range outside of the time parent range'], { value: 1, of: 1 });
    });

    test('count event starts strictly outside of the sample time axis and the furthest distance', async () => {
        // the axis is 100-140us
        const profile = await createScope({});

        profile.thread = {
            compilations: [
                { tm: 95, duration: 2 },
                { tm: 100, duration: 1 },
                { tm: 140, duration: 1 },
                { tm: 147, duration: 1 },
                { tm: null, duration: null },
                { tm: null, duration: null }
            ]
        } as unknown as typeof profile.thread;

        const rows = measure(profile);

        assert.deepEqual(rows['Events starting before the sample time axis'], { value: 1, of: 6 });
        assert.deepEqual(rows['Events starting after the sample time axis'], { value: 1, of: 6 });
        assert.deepEqual(rows['The furthest event start from the sample time axis'], { value: 7 });
    });
});

describe('correlations', () => {
    const timeline = correlations('timeline');
    const memline = correlations('memline');
    const script = { category: { name: 'script' }, total: 15 };
    // 15 samples over 10-50us in 3 bins, all of them in one of two categories
    const coverage = {
        start: 10,
        end: 50,
        categories: [{ category: { name: 'root' }, total: 0 }, script],
        bins: [1, 6, 8],
        outsideBins: [0, 1, 2]
    };

    test.each(['timeline', 'memline'])('of %s are unavailable without coverage', type => {
        const [unavailable] = findView(correlations(type), { view: 'switch' }).content;

        assert.equal(query(unavailable.when)(null), true);
        assert.equal(query(unavailable.when)(coverage), false);
    });

    test.each([
        ['the largest bin', coverage.bins, 8],
        ['1 for empty bins', [0, 0, 0], 1]
    ])('density spans the axis with a scale of %s', (_, bins, densityMax) => {
        const density = findView(timeline, { header: 'text:"Density over time from first sample"' }).content;

        assert.deepEqual(query(density.context)({ ...coverage, bins }, {}), { densityLength: 40, densityMax });
    });

    test('density shows all samples or the samples of the selected category', () => {
        const select = findView(timeline, { view: 'select', name: 'category' });
        const block = findView(timeline, { className: 'signal-density' });

        assert.deepEqual(query(select.data)(coverage), ['all', script]);
        assert.equal(query(select.text)('all'), 'All categories');
        assert.equal(query(select.text)(script), 'script');
        assert.equal(query(select.text)({ category: null }), 'Unknown');
        assert.equal(query(block.data)(coverage, { category: 'all' }), coverage);
        assert.equal(query(block.data)(coverage, { category: script }), script);
    });

    test('density details and legend sum the bins of all samples and of samples outside events', () => {
        const { details } = findView(timeline, { view: 'line-ruler' });
        const legend = query(findView(timeline, { view: 'labeled-value-list' }).data)(coverage);
        // segment bounds are inclusive
        const segment = { segmentStart: 1, segmentEnd: 2 };

        assert.equal(contentQuery(details[0])(coverage, segment), 'All: 14');
        assert.equal(contentQuery(details[1])(coverage, segment), ' / Outside: 3');
        assert.deepEqual(legend.map(item => item.value), [15, 3]);
    });

    test('density of allocations is labeled by compact counts, of CPU samples by the ruler', () => {
        const { formatLabel } = findView(memline, { view: 'line-ruler' });

        assert.equal(formatLabel(12.4), '12');
        assert.equal(formatLabel(1234.6), '1.2K');
        assert.equal(findView(timeline, { view: 'line-ruler' }).formatLabel, undefined);
    });

    test('allocations outside stages are split into before, within and after the CPU window', () => {
        const within = findView(memline, { header: 'Within CPU window' });

        assert.equal(contentQuery(within.content)({ outside: 10, before: 2, after: 3 }), 5);
        assert.deepEqual(findViews(timeline, { header: 'Within CPU window' }), []);
    });

    test('matrix rows start with samples outside events, then events by sample count', () => {
        const events = [
            { name: 'Parse', count: 1 },
            { name: null, count: 2 },
            { name: 'Compile', count: 3 },
            { name: 'Idle', count: 0 }
        ];
        const matrix = findView(timeline, { className: 'signal-matrix' });

        assert.deepEqual(query(matrix.data)({ events }).map(row => row.name), [null, 'Compile', 'Parse']);
    });

    test('matrix columns keep category indices when categories without samples are omitted', () => {
        const categories = [
            { category: { name: 'root' }, total: 0 },
            { category: { name: 'script' }, total: 3 },
            { category: { name: 'gc' }, total: 2 }
        ];
        const matrix = findView(timeline, { className: 'signal-matrix' });
        const cols = propQuery(matrix.cols)([], { categories });
        const scriptCell = cols[2].content;
        const row = { count: 4, counts: [0, 1, 3] };

        assert.deepEqual(cols.map(column => column.header), ['Event / stage', 'Samples', 'script', 'gc']);
        assert.equal(propQuery(scriptCell.value)(row), 1);
        assert.equal(propQuery(scriptCell.total)(row, { categories, denominator: 'event' }), 4);
        assert.equal(propQuery(scriptCell.total)(row, { categories, denominator: 'category' }), 3);
    });
});
