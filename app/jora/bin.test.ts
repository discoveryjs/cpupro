import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from './bin.js';
import { methods as profileMethods } from './profile.js';
import { methods as samplesMethods } from './samples.js';
import { methods as treeMethods } from './call-tree.js';
import { typeColor } from '../prepare/const.js';
import { CallTree } from '../prepare/computations/call-tree.js';
import { subtreeFromParent, nestedFromNodesSubtree } from '../prepare/computations/build-trees.js';
import type { Range } from '../prepare/computations/coordinates.js';
import type { ProfileLine } from '../prepare/lines/types.js';
import { createState, selectRange } from '../views/ruler-range.js';
import { createLineFixture, createProfileFixture, joinSession } from '../../test/fixtures/profile.js';
import { createLineMapping } from '../prepare/computations/line-mapping.js';
import { EventSignatures } from '../prepare/lines/event-signatures.js';
import { PopulationFiltered } from '../prepare/computations/population.js';
import type { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';
import { dictEntries } from '../../test/fixtures/lines.js';

type HeapEvents = Parameters<typeof methods.binHeapTotal>[0];
type FunctionCodes = Parameters<typeof methods.binScriptFunctionCodesTotal>[0];

const query = jora.setup({
    methods: {
        ...methods,
        ...samplesMethods,
        ...profileMethods
    }
});
const category = { name: 'script' };
const idle = { name: 'idle' };

// Events at 125–150 by default (values 10, 10, 5 of sample IDs 0, 1, 0), scoped to the viewport 100–200
async function createContext(
    options: Parameters<typeof createLineFixture>[0] = {},
    scopeViewport: Range | null = { start: 100, end: 200 }
) {
    const { profile, line, breakdown } = await createLineFixture({ origin: 125, ...options });

    return {
        scopeViewport,
        scopeLine: line,
        scopeProfile: profile,
        scopeBreakdown: breakdown
    };
}

async function createMappedSource(
    axis: ProfileLine,
    values = new Uint32Array([3, 4, 5]),
    mapping = new Uint32Array([0, 1, 2]),
    samples = Uint32Array.from(values, (_, i) => i)
) {
    const { line: source, breakdown } = await createLineFixture({ type: 'memline', values, samples });
    const axisEvents = Uint32Array.from({ length: axis.values.length }, (_, i) => i);
    const { memlineToTimeline, timelineToMemline } = createLineMapping(source, mapping, axis, axisEvents);

    source.mappings[axis.type] = memlineToTimeline;
    axis.mappings[source.type] = timelineToMemline;

    return { source, viewport: breakdown.populationViewport };
}

function createTree(dictionary: string[], nodes: Uint32Array, parent: Uint32Array) {
    const subtree = subtreeFromParent(parent);
    const nested = nestedFromNodesSubtree(nodes, subtree, dictionary.length);

    return new CallTree(dictionary, nodes, parent, subtree, nested);
}

// Metrics of a tree whose node N is entry N
function createFlatMetrics(dictionary: unknown[], sampleToNode: Uint32Array) {
    return {
        tree: { dictionary, nodes: Uint32Array.from(dictionary, (_, i) => i) },
        sampleToNode
    };
}

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % max;
}

function assertClose(actual: ArrayLike<number>, expected: ArrayLike<number>) {
    assert.equal(actual.length, expected.length);

    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i] - expected[i]) < 1e-8, `bin ${i}: ${actual[i]} instead of ${expected[i]}`);
    }
}

function heapEvents(events: [tm: number, event: 'new' | 'delete', size: number][]) {
    return events.map(event => ({ tm: event[0], event: event[1], size: event[2] })) as HeapEvents;
}

// Codes of functions numbered by the identity of their call frame codes
function functionCodes(codes: [tm: number, tier: string, fn: number][]) {
    const functions: object[] = [];
    const result: { tm: number; tier: string; callFrameCodes: object }[] = [];

    for (let i = 0; i < codes.length; i++) {
        const [tm, tier, fn] = codes[i];

        functions[fn] ??= {};
        result.push({ tm, tier, callFrameCodes: functions[fn] });
    }

    return result as FunctionCodes;
}

//
// Bin counts
//

test.each([
    [500, 0, 1],
    [500, 0.5, 1],
    [500, 1, 1],
    [500, 1.9, 1],
    [500, 12.7, 12],
    [500, 25, 25],
    [500, 499.9, 499],
    [500, 500, 500],
    [500, 500.9, 500],
    [500, 1000, 500],
    [500, 2 ** 32, 500],
    [1, 1000, 1],
    [25, 1000, 25]
])('binCount(%i) of a length or a range of %d is %i without requiring a scope', (maxCount, length, expected) => {
    assert.equal(query(`${maxCount}.binCount($)`)(length), expected);
    assert.equal(query(`${maxCount}.binCount($)`)({ start: -10, end: length - 10 }), expected);
});

test('binCount uses the resolved viewport only when its argument is omitted', async () => {
    const context = await createContext();
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([200]) });
    const nested = { ...context, scopeViewport: { start: 120, end: 125 } };
    const lineViewport = { ...context, scopeViewport: null };

    assert.equal(query('500.binCount()')({}, context), 100);
    assert.equal(query('500.binCount(scopeViewport())')({}, context), 100);
    assert.equal(query('500.binCount(missing)')({}, context), 100);
    assert.equal(query('500.binCount()')({}, nested), 5);
    assert.equal(query('500.binCount(0)')({}, nested), 1);
    assert.equal(query('500.binCount({ start: 0, end: 30 })')({}, nested), 30);
    assert.equal(query('500.binCount()')({}, lineViewport), 25);
    joinSession([context.scopeProfile, other.profile]);
    assert.equal(query('500.binCount()')({}, lineViewport), 200);
});

//
// Sample bins: binCallsFromMask, binCalls and binSignals (of the whole recording)
//

test.each([
    {
        name: 'the scope viewport',
        scopeViewport: { start: 100, end: 200 },
        profiles: [] as Uint32Array[],
        expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]
    },
    {
        name: 'the viewport of the profiles of its recording',
        scopeViewport: null,
        profiles: [new Uint32Array([100])],
        expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]
    },
    {
        name: 'a nested scope viewport',
        scopeViewport: { start: 125, end: 150 },
        profiles: [new Uint32Array([100])],
        expected: [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5]
    },
    {
        name: 'the line viewport',
        scopeViewport: null,
        profiles: [] as Uint32Array[],
        expected: [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5]
    }
])('sample and category bins of a short population are placed on $name', async row => {
    const createProfile = async (values: Uint32Array) => (await createLineFixture({ origin: 100, values })).profile;
    const others = await Promise.all(row.profiles.map(createProfile));
    const context = await createContext({}, row.scopeViewport);

    joinSession([context.scopeProfile, ...others]);

    const metrics = createFlatMetrics([category, idle], new Uint32Array([0, 1]));

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 10), row.expected);
    assert.deepEqual(Array.from(methods.binCalls.call({ context }, metrics, category, 10)), row.expected);
});

test.each([
    {
        name: 'a whole line of 101',
        options: { origin: 0, values: new Uint32Array([101]) },
        scopeViewport: { start: 0, end: 101 },
        expected: [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]
    },
    {
        name: 'a whole line of 25',
        options: { origin: 0, values: new Uint32Array([25]) },
        scopeViewport: { start: 0, end: 25 },
        expected: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]
    },
    {
        name: 'a whole line of 27',
        options: { origin: 0, values: new Uint32Array([27]) },
        scopeViewport: { start: 0, end: 27 },
        expected: [2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7]
    },
    {
        name: 'an offset population',
        options: {},
        scopeViewport: { start: 100, end: 201 },
        expected: [0, 0, 8, 11, 6, 0, 0, 0, 0, 0]
    },
    {
        name: 'a viewport inside an event',
        options: { origin: 0, values: new Uint32Array([1000]) },
        scopeViewport: { start: 400, end: 501 },
        expected: [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]
    }
])('sample bins over $name take the rounded step only when its excess stays within the last bin', async row => {
    const context = await createContext(row.options, row.scopeViewport);

    assertClose(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10), row.expected);
});

test.each([
    [130, 140, [5, 0]],
    [120, 130, [0, 5]],
    [145, 155, [5, 0]],
    [100, 110, [0, 0]],
    [160, 170, [0, 0]]
] as const)('clips sample intervals to viewport [%i, %i], leaving source values', async (start, end, expected) => {
    const context = await createContext({}, { start, end });
    const values = context.scopeLine.values.slice();

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 2), expected);
    assert.deepEqual(context.scopeLine.values, values);
});

test.each([101, 1001, 4961966])('bounds ruler approximation keeping integer binning for total=%i', async total => {
    const count = Math.min(500, total);
    const { breakdown } = await createLineFixture({ values: new Uint32Array([total]) });
    const context = { scopeBreakdown: breakdown };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1]), count);
    const state = createState(total, count);
    let boundary = 0;

    for (let i = 0; i < count; i++) {
        const selection = selectRange(state, (i + 0.1) / count, (i + 0.9) / count);

        assert.ok(Math.abs(boundary - selection.start) < Math.ceil(total / count));
        boundary += bins[i];
    }

    assert.ok(Math.abs(boundary - total) < 1e-6);
});

test('binSignals bins the whole recording regardless of the viewport, its window and filters', async () => {
    const context = await createContext();
    const metrics = createFlatMetrics([category, idle], new Uint32Array([0, 1]));
    const populations = [context.scopeBreakdown.populationViewport, context.scopeBreakdown.populationWindow];
    const options = {
        test: category,
        n: 10,
        total: 100,
        skip: 25
    };
    const signals = () => Array.from(methods.binSignals.call({ context }, metrics, options));
    const whole = signals();

    assert.deepEqual(whole, [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);

    // E.g. profile bars to choose a viewport on show what is outside of it
    for (let i = 0; i < populations.length; i++) {
        populations[i].setRanges([{ start: 10, end: 15 }]);
        populations[i].filter.set({
            key: 'sample',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(0, 0)
        });
    }

    assert.deepEqual(signals(), whole);

    for (let i = 0; i < populations.length; i++) {
        populations[i].setRanges(null);
        populations[i].filter.remove('sample');
    }
});

test('binSignals keeps explicit total and skip independent of the active viewport', async () => {
    const context = await createContext();
    const lineViewport = { ...context, scopeViewport: null };
    const metrics = createFlatMetrics([{}], new Uint32Array([0, 0]));
    const options = { n: 10, total: 101, skip: 25 };
    const expected = [0, 0, 8, 11, 6, 0, 0, 0, 0, 0];

    assert.deepEqual(Array.from(methods.binSignals.call({ context }, metrics, options)), expected);
    assert.deepEqual(Array.from(methods.binSignals.call({ context: lineViewport }, metrics, options)), expected);
});

const sinkCoverage = [
    {
        label: 'whole',
        ranges: null,
        expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]
    },
    {
        label: 'disjoint ranges',
        ranges: [{ start: 1, end: 8 }, { start: 12, end: 14 }, { start: 21, end: 24 }],
        expected: [0, 0, 4, 3, 3, 0, 0, 0, 0, 0]
    }
];

test.each((['timeline', 'memline'] as const).flatMap(type => sinkCoverage.map(row => ({ type, ...row }))))(
    'category bins on a $type ignore a sink overlapping unused tree samples ($label)',
    async row => {
        const context = await createContext({ type: row.type });
        const viewport = context.scopeBreakdown.populationWindow;
        const metrics = createFlatMetrics([category, idle], new Uint32Array([0, 1, 0, 1]));
        const mask = new Uint8Array([1, 0, 1, 0]);
        const empty = new Array(10).fill(0);
        const bins = () => [
            Array.from(methods.binCalls.call({ context }, metrics, category, 10)),
            methods.binCallsFromMask.call({ context }, mask, 10)
        ];

        // The sink of sample IDs 0 and 1 has the ID of an accepted tree sample
        assert.equal(mask[viewport.sinkId], 1);

        viewport.setRanges(row.ranges);
        assert.deepEqual(bins(), [row.expected, row.expected]);

        for (const filter of [
            {
                key: 'category',
                domain: 'sample',
                size: 2
            },
            {
                key: 'category',
                domain: 'event',
                size: 3,
                values: viewport.population.samples
            }
        ] as const) {
            viewport.filter.set({ ...filter, accepts: Uint8Array.of(1, 0) });
            assert.deepEqual(bins(), [row.expected, row.expected]);
            viewport.filter.set({ ...filter, accepts: Uint8Array.of(0, 0) });
            assert.deepEqual(bins(), [empty, empty]);
            viewport.filter.remove('category');
            assert.deepEqual(bins(), [row.expected, row.expected]);
        }

        assert.deepEqual([...mask], [1, 0, 1, 0]);
    }
);

const sinkIdCoverage = [
    {
        label: 'whole',
        ranges: null,
        expected: [0, 0, 5, 5, 5, 5, 0, 0]
    },
    {
        label: 'disjoint ranges',
        ranges: [{ start: 2, end: 17 }, { start: 23, end: 38 }],
        expected: [0, 0, 5, 2, 2, 5, 0, 0]
    }
];

test.each([0, 1, 7, 0xffffffff].flatMap(sinkId => sinkIdCoverage.map(row => ({ sinkId, ...row }))))(
    'binning excludes sink ID $sinkId without excluding other sample IDs ($label)',
    async row => {
        const context = await createContext({
            type: 'memline',
            origin: 0,
            values: new Uint32Array([10, 10, 10, 10]),
            samples: new Uint32Array([2, 2, 3, 3])
        }, { start: 0, end: 40 });
        const viewport = context.scopeBreakdown.populationWindow;
        const metrics = createFlatMetrics([category], new Uint32Array(8));
        const mask = new Uint8Array(8).fill(1);

        viewport.setRanges(row.ranges);
        Object.defineProperty(viewport, 'sinkId', { value: row.sinkId });
        viewport.samples.set([row.sinkId, 2, 3, row.sinkId]);

        assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 8), row.expected);
        assert.deepEqual(Array.from(methods.binCalls.call({ context }, metrics, category, 8)), row.expected);
        assert.deepEqual([...mask], new Array(8).fill(1));
    }
);

test('histogram bins and counters ignore selection ranges and filters', async () => {
    const context = await createContext();
    const selection = context.scopeBreakdown.populationFiltered;

    selection.setRange(20, 25);
    selection.filter.set({
        key: 'selection',
        domain: 'sample',
        size: 2,
        accepts: new Uint8Array(2)
    });

    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10);
    const counts = samplesMethods.countSamples.call({ context }, 10);

    assert.deepEqual(bins, [0, 0, 5, 10, 10, 0, 0, 0, 0, 0]);
    assert.deepEqual([...counts], [0, 0, 1, 2, 2, 0, 0, 0, 0, 0]);
});

// Events at 0, 0–10, 10–280, 280–285, 285–685, 685–1000 and 1000 of sample IDs 0, 1, 0, 1, 1, 0, 0
async function createScatteredContext(scopeViewport: Range) {
    return createContext({
        origin: 0,
        values: new Uint32Array([0, 10, 270, 5, 400, 315, 0]),
        samples: new Uint32Array([0, 1, 0, 1, 1, 0, 0])
    }, scopeViewport);
}

test.each([
    {
        name: 'a viewport before the line start',
        range: { start: -50, end: 150 },
        count: 3,
        entries: [category],
        expected: [7, 67, 66]
    },
    {
        name: 'a viewport within the line',
        range: { start: 250, end: 400 },
        count: 10,
        entries: [category],
        expected: [15, 15, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    {
        name: 'a viewport across the line end',
        range: { start: 900, end: 1050 },
        count: 10,
        entries: [category, idle],
        expected: [15, 15, 15, 15, 15, 15, 10, 0, 0, 0]
    },
    {
        name: 'a viewport after the line',
        range: { start: 1200, end: 1301 },
        count: 3,
        entries: [category, idle],
        expected: [0, 0, 0]
    }
])('binSignals clips events to an explicit total and skip of $name', async row => {
    const context = await createScatteredContext({ start: 0, end: 1000 });
    const metrics = createFlatMetrics([category, idle], new Uint32Array([0, 1]));
    const options = {
        n: row.count,
        total: row.range.end - row.range.start,
        skip: -row.range.start,
        test: (entry: typeof category) => row.entries.includes(entry)
    };

    assert.deepEqual(Array.from(methods.binSignals.call({ context }, metrics, options)), row.expected);
});

const disjointRanges = [
    { start: 1, end: 4 },
    { start: 6, end: 8 },
    { start: 90, end: 300 },
    { start: 701, end: 810 }
];

// Bins of the window take only its participating parts of events, whose coordinates stay those of Base; counters
// count events intersecting each bin, and visible event starts, once
test.each([
    {
        name: 'the whole line',
        scopeViewport: { start: 0, end: 1000 },
        count: 10,
        ranges: null,
        accepts: [1, 1],
        bins: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
        counts: [2, 1, 3, 1, 1, 1, 2, 1, 1, 1],
        starts: [2, 0, 2, 0, 0, 0, 1, 0, 0, 0]
    },
    {
        name: 'a rejected sample',
        scopeViewport: { start: 0, end: 1000 },
        count: 10,
        ranges: null,
        accepts: [1, 0],
        bins: [90, 100, 80, 0, 0, 0, 15, 100, 100, 100],
        counts: [1, 1, 1, 0, 0, 0, 1, 1, 1, 1],
        starts: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0]
    },
    {
        name: 'empty ranges',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: [],
        accepts: [1, 1],
        bins: [0, 0, 0, 0],
        counts: [0, 0, 0, 0],
        starts: [0, 0, 0, 0]
    },
    {
        name: 'a range of one event on an offset grid',
        scopeViewport: { start: -30, end: 170 },
        count: 10,
        ranges: [{ start: 1, end: 19 }],
        accepts: [1, 1],
        bins: [0, 9, 9, 0, 0, 0, 0, 0, 0, 0],
        counts: [0, 1, 1, 0, 0, 0, 0, 0, 0, 0],
        starts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
    },
    {
        name: 'a range across event edges',
        scopeViewport: { start: -30, end: 170 },
        count: 4,
        ranges: [{ start: 25, end: 280 }],
        accepts: [1, 1],
        bins: [0, 45, 50, 50],
        counts: [0, 1, 1, 1],
        starts: [0, 0, 0, 0]
    },
    {
        name: 'disjoint ranges cutting shared events',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: disjointRanges,
        accepts: [1, 1],
        bins: [165, 50, 49, 60],
        counts: [2, 3, 1, 1],
        starts: [0, 2, 0, 0]
    },
    {
        name: 'disjoint ranges with a rejected sample',
        scopeViewport: { start: 0, end: 1000 },
        count: 10,
        ranges: disjointRanges,
        accepts: [1, 0],
        bins: [10, 100, 80, 0, 0, 0, 0, 99, 10, 0],
        counts: [1, 1, 1, 0, 0, 0, 0, 1, 1, 0],
        starts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    {
        name: 'offset ranges with a rejected sample',
        scopeViewport: { start: -30, end: 170 },
        count: 4,
        ranges: disjointRanges,
        accepts: [1, 0],
        bins: [0, 0, 30, 50],
        counts: [0, 0, 1, 1],
        starts: [0, 0, 0, 0]
    },
    {
        name: 'disjoint ranges in a single bin',
        scopeViewport: { start: 0, end: 1000 },
        count: 1,
        ranges: disjointRanges,
        accepts: [1, 1],
        bins: [324],
        counts: [5],
        starts: [2]
    },
    {
        name: 'two ranges of one event in two bins',
        scopeViewport: { start: 0, end: 1000 },
        count: 10,
        ranges: [{ start: 15, end: 30 }, { start: 120, end: 140 }],
        accepts: [1, 1],
        bins: [15, 20, 0, 0, 0, 0, 0, 0, 0, 0],
        counts: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
        starts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    {
        name: 'a viewport across the line end',
        scopeViewport: { start: 900, end: 1100 },
        count: 4,
        ranges: null,
        accepts: [1, 1],
        bins: [50, 50, 0, 0],
        counts: [1, 1, 0, 0],
        starts: [0, 0, 0, 0]
    }
])('window bins and counters of $name', async row => {
    const context = await createScatteredContext(row.scopeViewport);
    const viewport = context.scopeBreakdown.populationWindow;
    const line = context.scopeLine;

    viewport.setRanges(row.ranges);
    viewport.filter.set({
        key: 'samples',
        domain: 'sample',
        size: 2,
        accepts: Uint8Array.from(row.accepts)
    });

    const [own] = methods.binLineToAxisLine.call({ context }, line, null, line, row.count);

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), row.count), row.bins);
    assert.deepEqual([...own.bins], row.bins);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, row.count)], row.counts);
    assert.deepEqual([...samplesMethods.countSamplesDiscrete.call({ context }, row.count, undefined)], row.starts);
});

//
// Category tree bins: binTreeSamples
//

const treeRanges = [
    { start: 2, end: 9 },
    { start: 12, end: 20 },
    { start: 30, end: 280 },
    { start: 700, end: 999 }
];

// root -> A -> B -> A -> C and root -> B -> C; events 1–5 are self samples of the outer A, the outer B, the inner A,
// the inner C and the C under the second B
test.each([
    {
        name: 'the whole line',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1],
        bins: [[0, 0, 0, 0], [10, 5, 0, 0], [240, 30, 0, 0], [0, 215, 250, 250]],
        nested: [[1, 1, 1, 1], [1, 1, 1, 0], [0, 1, 1, 1], [0, 0, 0, 0]],
        values: [0, 15, 270, 715]
    },
    {
        name: 'rejected events',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: null,
        accepts: [1, 0, 1, 0, 1, 0],
        bins: [[0, 0, 0, 0], [0, 0, 0, 0], [240, 30, 0, 0], [0, 215, 185, 0]],
        nested: [[1, 1, 1, 0], [1, 1, 1, 0], [0, 1, 1, 0], [0, 0, 0, 0]],
        values: [0, 0, 270, 400]
    },
    {
        name: 'disjoint ranges',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: treeRanges,
        accepts: [1, 1, 1, 1, 1, 1],
        bins: [[0, 0, 0, 0], [7, 0, 0, 0], [228, 30, 0, 0], [0, 0, 50, 249]],
        nested: [[1, 1, 1, 1], [1, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 0]],
        values: [0, 7, 258, 299]
    },
    {
        name: 'rejected events of offset ranges',
        scopeViewport: { start: -50, end: 151 },
        count: 3,
        ranges: treeRanges,
        accepts: [1, 0, 1, 0, 1, 0],
        bins: [[0, 0, 0], [0, 0, 0], [5, 57, 67], [0, 0, 0]],
        nested: [[1, 1, 1], [1, 1, 1], [0, 0, 0], [0, 0, 0]],
        values: [0, 0, 129, 0]
    },
    {
        name: 'a viewport across the line end',
        scopeViewport: { start: 900, end: 1100 },
        count: 4,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1],
        bins: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [50, 50, 0, 0]],
        nested: [[1, 1, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0]],
        values: [0, 0, 0, 100]
    },
    {
        name: 'a viewport after the line',
        scopeViewport: { start: 1200, end: 1300 },
        count: 4,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1],
        bins: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        nested: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        values: [0, 0, 0, 0]
    },
    {
        name: 'empty ranges',
        scopeViewport: { start: 0, end: 1000 },
        count: 4,
        ranges: [],
        accepts: [1, 1, 1, 1, 1, 1],
        bins: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        nested: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        values: [0, 0, 0, 0]
    }
])('tree bins of $name hold self values and presence of other entries in subtrees', async row => {
    const context = await createContext({
        origin: 0,
        values: new Uint32Array([0, 10, 270, 5, 400, 315]),
        samples: new Uint32Array([0, 1, 2, 3, 4, 5])
    }, row.scopeViewport);
    const nodes = new Uint32Array([0, 1, 2, 1, 3, 2, 3]);
    const tree = createTree(['root', 'A', 'B', 'C'], nodes, new Uint32Array([0, 0, 1, 2, 3, 0, 5]));
    const metrics = { tree, sampleToNode: new Uint32Array([0, 1, 2, 3, 4, 6]) };
    const viewport = context.scopeBreakdown.populationWindow;

    viewport.setRanges(row.ranges);
    viewport.filter.set({
        key: 'event',
        domain: 'event',
        size: 6,
        accepts: Uint8Array.from(row.accepts)
    });

    const rows = methods.binTreeSamples.call({ context }, metrics, row.count);

    assert.deepEqual(rows.map(entry => [...entry.bins]), row.bins);
    assert.deepEqual(rows.map(entry => [...entry.nestedPresence]), row.nested);
    assert.deepEqual(rows.map(entry => entry.value), row.values);
});

test.each([
    // root -> B -> A -> B, with self samples of A and the inner B
    {
        name: 'an entry inside a recursive entry',
        nodes: [0, 2, 1, 2],
        parent: [0, 0, 1, 2],
        expected: [1, 1, 1]
    },
    // root -> B -> (B, B), with self samples of both inner B
    {
        name: 'sibling subtrees of the same entry',
        nodes: [0, 2, 2, 2],
        parent: [0, 0, 1, 1],
        expected: [1, 0, 0]
    }
])('nested presence marks entries with other entries in their subtrees: $name', async row => {
    const options = {
        origin: 0,
        values: new Uint32Array([10, 10]),
        samples: new Uint32Array([0, 1])
    };
    const context = await createContext(options, { start: 0, end: 20 });
    const tree = createTree(['root', 'A', 'B'], new Uint32Array(row.nodes), new Uint32Array(row.parent));
    const rows = methods.binTreeSamples.call({ context }, { tree, sampleToNode: new Uint32Array([2, 3]) }, 1);

    assert.deepEqual(rows.map(entry => [...entry.nestedPresence]), row.expected.map(present => [present]));
});

test('nested presence preserves fractional contributions and excludes recursive self', async () => {
    const options = {
        origin: 0,
        values: new Uint32Array([1]),
        samples: new Uint32Array([0])
    };
    const context = await createContext(options, { start: 0, end: 1e-9 });
    const tree = createTree(['root', 'leaf'], new Uint32Array([0, 1, 1]), new Uint32Array([0, 0, 1]));
    const metrics = { tree, sampleToNode: new Uint32Array([2]) };
    const rows = methods.binTreeSamples.call({ context }, metrics, 1);

    assert.deepEqual(rows.map(row => [...row.nestedPresence]), [[1], [0]]);
    assert.ok(rows[1].value > 0);

    context.scopeViewport = { start: 0.3, end: 0.6 };
    const clipped = methods.binTreeSamples.call({ context }, metrics, 1);
    const expected = (1 - 0.3) - (1 - 0.6);

    assert.equal(clipped[1].bins[0], expected);
    assert.equal(clipped[1].value, expected);
});

test('category workspace does not grow by node count for every additional bin', async () => {
    const options = {
        origin: 0,
        values: new Uint32Array([1000]),
        samples: new Uint32Array([0])
    };
    const context = await createContext(options, { start: 0, end: 1000 });
    const nodes = Uint32Array.from({ length: 64 }, (_, i) => i % 3);
    const dictionary = ['a', 'b', 'c'];
    const tree = createTree(dictionary, nodes, Uint32Array.from(nodes, (_, i) => Math.max(0, i - 1)));
    const metrics = { tree, sampleToNode: new Uint32Array([63]) };
    const original = globalThis.Float64Array;
    let cells = 0;

    globalThis.Float64Array = new Proxy(original, {
        construct(target, args) {
            const array = Reflect.construct(target, args);

            cells += array.length;

            return array;
        }
    });

    try {
        // Warms up the population workspace
        methods.binTreeSamples.call({ context }, metrics, 1);
        cells = 0;
        methods.binTreeSamples.call({ context }, metrics, 64);
        const first = cells;
        cells = 0;
        methods.binTreeSamples.call({ context }, metrics, 128);
        assert.equal(cells - first, dictionary.length * 64);
    } finally {
        globalThis.Float64Array = original;
    }
});

//
// Allocation bins on the line's own axis: binLineToAxisLine
//

test.each([
    {
        name: 'the whole line',
        scopeViewport: null,
        ranges: null,
        counts: [1, 7, 50, 160],
        values: [16, 80, 64]
    },
    {
        name: 'a viewport within the line',
        scopeViewport: { start: 0, end: 48 },
        ranges: null,
        counts: [1, 7],
        values: [16, 32, 0]
    },
    {
        name: 'fractional window ranges',
        scopeViewport: null,
        ranges: [{ start: 1, end: 1.5 }, { start: 3, end: 3.5 }, { start: 20, end: 25 }],
        counts: [1, 7, 50],
        values: [1, 5, 0]
    }
])('allocation row values of $name do not depend on the number of bins', async row => {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([16, 32, 48, 64]),
        samples: new Uint32Array([0, 1, 1, 2])
    });
    const attribute = {
        name: 'allocationType' as const,
        keys: new Uint32Array([0, 1, 1, 2]),
        entries: dictEntries(['first', 'second', 'third']),
        dict: ['first', 'second', 'third']
    };
    const context = {
        scopeLine: line,
        scopeBreakdown: breakdown,
        scopeViewport: row.scopeViewport
    };

    breakdown.populationWindow.setRanges(row.ranges);

    for (let i = 0; i < row.counts.length; i++) {
        const rows = methods.binLineToAxisLine.call({ context }, line, attribute, line, row.counts[i]);

        assert.deepEqual(rows.map(entry => entry.value), row.values);
        assert.deepEqual(rows.map(entry => entry.bins.length), [row.counts[i], row.counts[i], row.counts[i]]);
    }
});

// Allocations at 0–3, 3, 3–7, 7–9, 9–21, 21–22, 22–23, 23–29, 29–32 and 32–40
// of types a, b, c, a, b, c, …
async function createAllocationContext(scopeViewport: Range) {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([3, 0, 4, 2, 12, 1, 1, 6, 3, 8]),
        samples: new Uint32Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0])
    });

    return { scopeLine: line, scopeBreakdown: breakdown, scopeViewport };
}

const fractionalRanges = [{ start: 1.5, end: 12.25 }, { start: 20.5, end: 35.75 }];

// Bins are integer, so each fractional part is truncated when it's added; values sum the exact parts
test.each([
    {
        name: 'whole, crossing and zero-weight events',
        scopeViewport: { start: 0, end: 40 },
        count: 4,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [10, 10, 10, 10],
        value: 40
    },
    {
        name: 'rejected edge, crossing, whole events',
        scopeViewport: { start: 0, end: 40 },
        count: 4,
        ranges: null,
        accepts: [0, 1, 1, 1, 0, 1, 0, 1, 1, 1],
        bins: [6, 0, 8, 10],
        value: 24
    },
    {
        name: 'rejected events spanning bins',
        scopeViewport: { start: 0, end: 40 },
        count: 8,
        ranges: null,
        accepts: [0, 1, 1, 1, 0, 1, 0, 1, 1, 1],
        bins: [2, 4, 0, 0, 3, 5, 5, 5],
        value: 24
    },
    {
        name: 'fractional range cuts',
        scopeViewport: { start: 0, end: 40 },
        count: 4,
        ranges: fractionalRanges,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [8, 2, 9, 5],
        value: 26
    },
    {
        name: 'fractional cuts of rejected events',
        scopeViewport: { start: 0, end: 40 },
        count: 4,
        ranges: fractionalRanges,
        accepts: [0, 1, 1, 1, 0, 1, 0, 1, 1, 1],
        bins: [6, 0, 8, 5],
        value: 19.75
    },
    {
        name: 'a fractional viewport offset',
        scopeViewport: { start: -2.5, end: 37.5 },
        count: 4,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [7, 9, 9, 9],
        value: 37.5
    },
    {
        name: 'fractional cuts on an offset viewport',
        scopeViewport: { start: -2.5, end: 37.5 },
        count: 4,
        ranges: fractionalRanges,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [5, 4, 6, 7],
        value: 26
    },
    {
        name: 'a narrow viewport',
        scopeViewport: { start: 10.25, end: 30.75 },
        count: 2,
        ranges: null,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [10, 9],
        value: 20.5
    },
    {
        name: 'empty ranges',
        scopeViewport: { start: 0, end: 40 },
        count: 4,
        ranges: [],
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        bins: [0, 0, 0, 0],
        value: 0
    }
])('allocation bins of $name take the participating parts of events', async row => {
    const context = await createAllocationContext(row.scopeViewport);
    const viewport = context.scopeBreakdown.populationWindow;

    viewport.setRanges(row.ranges);
    viewport.filter.set({
        key: 'event',
        domain: 'event',
        size: 10,
        accepts: Uint8Array.from(row.accepts)
    });

    const [own] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, row.count);

    assert.deepEqual([...own.bins], row.bins);
    assert.equal(own.value, row.value);
});

test.each([
    {
        name: 'fractional cuts of rejected events',
        count: 4,
        ranges: fractionalRanges,
        accepts: [0, 1, 1, 1, 0, 1, 0, 1, 1, 1],
        tracks: [[2, 0, 0, 3], [0, 0, 6, 0], [4, 0, 2, 2]],
        values: [5.75, 6, 8]
    },
    {
        name: 'a single bin of rejected events',
        count: 1,
        ranges: null,
        accepts: [0, 1, 1, 1, 0, 1, 0, 1, 1, 1],
        tracks: [[10], [6], [8]],
        values: [10, 6, 8]
    },
    {
        name: 'a single bin of fractional range cuts',
        count: 1,
        ranges: fractionalRanges,
        accepts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        tracks: [[7], [9], [8]],
        values: [8.25, 9.75, 8]
    }
])('attribute tracks split allocation bins of $name by the values of either vector type', async row => {
    const context = await createAllocationContext({ start: 0, end: 40 });
    const line = context.scopeLine;
    const viewport = context.scopeBreakdown.populationWindow;
    const types = new Uint32Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);

    viewport.setRanges(row.ranges);
    viewport.filter.set({
        key: 'event',
        domain: 'event',
        size: 10,
        accepts: Uint8Array.from(row.accepts)
    });

    for (const values of [Uint8Array.from(types), types]) {
        const attribute = { name: 'allocationType' as const, keys: values, entries: dictEntries(['a', 'b', 'c']), dict: ['a', 'b', 'c'] };
        const rows = methods.binLineToAxisLine.call({ context }, line, attribute, line, row.count);

        assert.deepEqual(rows.map(entry => [...entry.bins]), row.tracks);
        assert.deepEqual(rows.map(entry => entry.value), row.values);
    }
});

//
// Allocation bins on a mapped axis: binLineToAxisLine
//

test('mapped single-bin totals preserve wide sums with and without groups', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(
        context.scopeLine,
        new Uint32Array([0xffffffff, 5]),
        new Uint32Array([0, 1]),
        new Uint32Array([0, 0])
    );
    const attribute = {
        name: 'allocationType' as const,
        keys: new Uint8Array([0, 0]),
        entries: dictEntries(['all']),
        dict: ['all']
    };
    const axisFilter = {
        key: 'test',
        domain: 'event',
        size: 3,
        accepts: Uint8Array.of(0, 1, 0)
    } as const;

    for (const grouping of [null, attribute]) {
        const [row] = methods.binLineToAxisLine.call({ context }, source, grouping, context.scopeLine, 1);

        assert.equal(row.value, 2 ** 32 + 4);
        assert.deepEqual(row.bins, new Uint32Array([4]));
    }

    context.scopeBreakdown.populationWindow.filter.set(axisFilter);
    for (const grouping of [null, attribute]) {
        const [row] = methods.binLineToAxisLine.call({ context }, source, grouping, context.scopeLine, 1);

        assert.equal(row.value, 5);
        assert.deepEqual(row.bins, new Uint32Array([5]));
    }
});

test('allocation mapping uses the axis viewport while retaining source values', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);
    const [mapped] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);
    const [own] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10);

    assert.deepEqual(Array.from(mapped.bins), [0, 0, 3, 4, 5, 0, 0, 0, 0, 0]);
    assert.equal(mapped.value, 12);
    assert.deepEqual(Array.from(own.bins), [0, 0, 5, 10, 10, 0, 0, 0, 0, 0]);
    assert.equal(own.step, 10);
});

test.each([
    {
        name: 'outside a narrow viewport',
        scopeViewport: { start: 130, end: 140 },
        count: 2,
        mapped: [0, 4],
        own: [5, 5]
    },
    {
        name: 'at the end of the viewport',
        scopeViewport: { start: 130, end: 145 },
        count: 3,
        mapped: [0, 4, 0],
        own: [5, 5, 5]
    }
])('does not fold allocations mapped $name into the last bin', async row => {
    const context = await createContext({}, row.scopeViewport);
    const { source } = await createMappedSource(context.scopeLine);
    const [mappedRow] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, row.count);
    const [ownRow] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, row.count);

    assert.deepEqual(Array.from(mappedRow.bins), row.mapped);
    assert.equal(mappedRow.value, 4);
    assert.deepEqual(Array.from(ownRow.bins), row.own);
});

test('allocation bins apply source and axis viewport participation, keeping Base coordinates', async () => {
    const context = await createContext();
    const axis = context.scopeBreakdown.populationWindow;
    const { source, viewport } = await createMappedSource(context.scopeLine);
    const mapped = () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];

    viewport.setRange(1, 10);
    assert.deepEqual([...mapped().bins], [0, 0, 2, 4, 3, 0, 0, 0, 0, 0]);
    viewport.filter.set({
        key: 'allocations',
        domain: 'event',
        size: 3,
        accepts: Uint8Array.of(1, 0, 1)
    });
    assert.deepEqual([...mapped().bins], [0, 0, 2, 0, 3, 0, 0, 0, 0, 0]);
    axis.setRanges([{ start: 10, end: 25 }]);
    assert.deepEqual([...mapped().bins], [0, 0, 0, 0, 3, 0, 0, 0, 0, 0]);
    axis.filter.set({ key: 'axis', domain: 'sample', size: 2, accepts: Uint8Array.of(0, 1) });
    assert.equal(mapped().value, 0);

    axis.filter.remove('axis');
    axis.setRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 21, end: 24 }]);
    const [own] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10);

    assert.deepEqual([...own.bins], [0, 0, 2, 0, 3, 0, 0, 0, 0, 0]);
    assert.deepEqual([...context.scopeLine.values], [10, 10, 5]);
});

test('mapped bins take axis participation from the axis line scope breakdown, otherwise one of its kind', async () => {
    const context = await createContext();
    const axisBreakdown = context.scopeBreakdown;
    const { source } = await createMappedSource(context.scopeLine);
    const other = new PopulationFiltered(axisBreakdown.population);
    const value = () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0].value;

    other.setRanges([]);
    context.scopeBreakdown = { ...axisBreakdown, populationWindow: other };
    assert.equal(value(), 0);

    axisBreakdown.populationWindow.setRanges([]);
    context.scopeBreakdown = source.breakdowns[0];
    assert.equal(value(), 0);

    axisBreakdown.populationWindow.setRanges(null);
    assert.equal(value(), 12);
    other.destroy();
});

// Allocations of 16, 32, 48 and 64 bytes: with script categories excluded, call stacks reject them all, locations
// accept the allocation of 64 bytes without a script. A breakdown's own attribution decides its category, and the scope
// breakdown decides the population
test.each([
    {
        name: 'call stacks of the memline',
        scopeLine: 'memline',
        kind: 'call-stack',
        value: 0
    },
    {
        name: 'locations of the memline',
        scopeLine: 'memline',
        kind: 'location',
        value: 64
    },
    {
        name: 'source-mapped locations of the memline',
        scopeLine: 'memline',
        kind: 'location-sm',
        value: 64
    },
    {
        name: 'call stacks of the timeline',
        scopeLine: 'timeline',
        kind: 'call-stack',
        value: 0
    }
] as const)('allocations under a category filter follow the scope breakdown: $name', async row => {
    const { profile } = await createProfileFixture();
    const memline = profile.memline!;
    const scopeLine = profile[row.scopeLine]!;
    const context = {
        scopeProfile: profile,
        scopeLine,
        scopeBreakdown: scopeLine.breakdowns.find(breakdown => breakdown.kind === row.kind)!,
        data: { profiles: [profile] }
    };

    (memline.filters.get('category') as SetAttributeFilter).setSelection('exclude', ['script']);

    const [track] = methods.binLineToAxisLine.call({ context }, memline, null, scopeLine, 1);

    assert.equal(track.value, row.value);
});

test('the window of a source line, a range of its own axis, does not narrow its bins on another axis', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);
    const [ownBreakdown] = source.breakdowns;
    const ownContext = {
        ...context,
        scopeLine: source,
        scopeBreakdown: ownBreakdown,
        scopeViewport: undefined
    };
    const mapped = () => [...methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0].bins];
    const ownTotal = () => {
        const [row] = methods.binLineToAxisLine.call({ context: ownContext }, source, null, source, 12);

        return row.bins.reduce((sum, value) => sum + value, 0);
    };
    const bins = mapped();

    assert.equal(ownTotal(), 12);
    // E.g. a memline window following a zoom synchronized through time, cells of halvings of the bytes extent
    ownBreakdown.populationWindow.setRanges([{ start: 3, end: 4 }]);
    assert.deepEqual(mapped(), bins);
    // On its own axis the window is the range of histogram data
    assert.equal(ownTotal(), 1);
    ownBreakdown.populationWindow.setRanges(null);
});

// Allocation 3 is recorded after the last of the three samples of the axis
test('mapped allocation bins leave out allocations recorded after the last sample', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(
        context.scopeLine,
        new Uint32Array([3, 4, 5, 6]),
        new Uint32Array([0, 1, 2, 3])
    );
    const [row] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);
    const [total] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 1);

    assert.deepEqual([...source.mappings.timeline._mapping], [0, 1, 2, 3]);
    assert.equal(row.value, 12);
    assert.equal(total.value, 12);
});

test('mapped bins take source participation of a range inside one allocation and a later range', async () => {
    const context = await createContext();
    const { source, viewport } = await createMappedSource(context.scopeLine);

    viewport.setRanges([{ start: 1, end: 2 }, { start: 4, end: 12 }]);

    const [row] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);

    assert.deepEqual([...row.bins], [0, 0, 1, 3, 5, 0, 0, 0, 0, 0]);
    assert.equal(row.value, 9);
});

// Two ranges cut the first allocation (1.25 and 0.75 of its 3) and the second range the last one (1.5 of its 5):
// bins are integer, so a fractional part is truncated when it's added; the value sums the exact parts
test('mapped bins take the exact covered parts of allocations cut by fractional ranges', async () => {
    const context = await createContext();
    const { source, viewport } = await createMappedSource(context.scopeLine);

    viewport.setRanges([{ start: 0.5, end: 1.75 }, { start: 2.25, end: 8.5 }]);

    const [row] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);

    assert.deepEqual([...row.bins], [0, 0, 2, 4, 1, 0, 0, 0, 0, 0]);
    assert.equal(row.value, 7.5);
});

test.each([
    {
        name: 'from the start of a range',
        ranges: [{ start: 10, end: 25 }],
        expected: [0, 0, 0, 4, 5, 0, 0, 0, 0, 0]
    },
    {
        name: 'not before a range they overlap',
        ranges: [{ start: 15, end: 25 }],
        expected: [0, 0, 0, 0, 5, 0, 0, 0, 0, 0]
    },
    {
        name: 'not at the end of a range',
        ranges: [{ start: 0, end: 10 }, { start: 12, end: 25 }],
        expected: [0, 0, 3, 0, 5, 0, 0, 0, 0, 0]
    }
])('mapped targets are placed by their start within axis ranges: $name', async row => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);

    context.scopeBreakdown.populationWindow.setRanges(row.ranges);

    const [mapped] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);

    assert.deepEqual([...mapped.bins], row.expected);
});

test('allocations of unmapped targets and of targets past the axis add nothing to mapped bins', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(
        context.scopeLine,
        new Uint32Array([3, 4, 5, 6, 7]),
        new Uint32Array([0, 0, 0, 1, 2])
    );

    source.mappings.timeline._mapping = new Uint32Array([0, 3, 0xffffffff, 1, 2]);
    source.mappings.timeline.nondecreasing = false;

    const [bins] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);
    const [summary] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 1);

    assert.deepEqual([...bins.bins], [0, 0, 3, 6, 7, 0, 0, 0, 0, 0]);
    assert.equal(bins.value, 16);
    assert.deepEqual([...summary.bins], [16]);
    assert.equal(summary.value, 16);
});

test.each([
    { name: 'events', grouped: false },
    { name: 'signature records', grouped: true }
])('mapped bins from $name read only allocations with targets near the grid', async row => {
    // 30 axis events of 10, each the target of 100 consecutive allocations of 1
    const length = 3000;
    const context = await createContext({
        origin: 0,
        values: new Uint32Array(30).fill(10),
        samples: new Uint32Array(30)
    }, { start: 100, end: 150 });
    const axis = context.scopeLine;
    const { source } = await createMappedSource(
        axis,
        new Uint32Array(length).fill(1),
        Uint32Array.from({ length }, (_, i) => Math.floor(i / 100)),
        new Uint32Array(length)
    );
    const wholeAxis = { ...context, scopeViewport: { start: 0, end: 300 } };
    const reads = new Set<number>();

    if (row.grouped) {
        source.signatures = new EventSignatures(source);
        axis.signatures = new EventSignatures(axis);
    }

    source.mappings.timeline._mapping = new Proxy(source.mappings.timeline._mapping, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads.add(Number(property));
            }

            const value = Reflect.get(target, property, target);

            return typeof value === 'function' ? value.bind(target) : value;
        }
    });

    // Records of whole targets are built once per line, on the first aggregation of any grid
    methods.binLineToAxisLine.call({ context: wholeAxis }, source, null, axis, 3);
    reads.clear();

    const [mapped] = methods.binLineToAxisLine.call({ context }, source, null, axis, 5);

    assert.deepEqual([...mapped.bins], [100, 100, 100, 100, 100]);
    assert.equal(mapped.value, 500);
    // Targets 10–14 are on the grid; with one more target on each side, allocations 900–1599 are read, besides two
    // edge allocations and two binary searches
    assert.ok(reads.size <= 700 + 2 + 2 * Math.ceil(Math.log2(length + 1)), `${reads.size} allocations read`);
});

test('mapped records of whole targets equal event binning across source range cuts and filters', async () => {
    const random = sequence(3);
    const axisValues = Uint32Array.from({ length: 30 }, () => 1 + random(9));
    const axisSamples = Uint32Array.from(axisValues, () => random(3));
    const context = await createContext({ values: axisValues, samples: axisSamples });
    const axis = context.scopeLine;
    const axisViewport = context.scopeBreakdown.populationWindow;
    const targets = Uint32Array.from({ length: 400 }, () => random(axisValues.length)).sort();
    const weights = Uint32Array.from(targets, () => random(6) === 0 ? 0 : 1 + random(20));
    const samples = Uint32Array.from(targets, () => random(4));
    const { source, viewport } = await createMappedSource(axis, weights, targets, samples);
    const types = Uint32Array.from(targets, () => random(3));
    const attribute = {
        name: 'allocationType' as const,
        keys: types,
        entries: dictEntries(['a', 'b', 'c']),
        dict: ['a', 'b', 'c']
    };
    const start = axis.range.frame.resolveValue(0);
    const total = axisValues.reduce((sum, value) => sum + value, 0);
    const cumulative = viewport.population.cumulative;
    const sourceTotal = viewport.population.cumulativeEnd;
    const grids = [
        { from: 0, to: 1, count: 9 },
        { from: 0.2, to: 0.7, count: 11 },
        { from: 0.4, to: 0.45, count: 2 },
        { from: 0, to: 1, count: 1 }
    ];
    const binGrid = (grid: typeof grids[number]) => {
        const scopeViewport = { start: start + total * grid.from, end: start + total * grid.to };
        const rows = methods.binLineToAxisLine.call(
            { context: { ...context, scopeViewport } },
            source,
            attribute,
            axis,
            grid.count
        );

        return rows.map(row => [row.value, ...row.bins]);
    };
    const bins = () => grids.map(binGrid);
    const signatures = () => {
        source.signatures = new EventSignatures(source);
        axis.signatures = new EventSignatures(axis);
    };
    const events = () => {
        source.signatures = null;
        axis.signatures = null;
    };

    source.attributes = [attribute];
    viewport.filter.set({
        key: 'source',
        domain: 'event',
        size: targets.length,
        values: types,
        accepts: Uint8Array.of(1, 1, 0)
    });

    for (const ranges of [
        null,
        // Cuts inside events of one target, at event edges, and gaps over whole targets
        [
            { start: cumulative[37] + 0.5, end: cumulative[90] },
            { start: cumulative[90] + 1, end: cumulative[211] + 0.25 },
            { start: cumulative[300], end: sourceTotal }
        ],
        [{ start: cumulative[5] + 1, end: cumulative[6] }]
    ]) {
        const label = JSON.stringify(ranges);

        viewport.setRanges(ranges);
        events();
        const expected = bins();

        signatures();
        assert.deepEqual(bins(), expected, label);
        // Complete records of the grids are reused
        assert.deepEqual(bins(), expected, `${label} with complete records`);

        axisViewport.filter.set({
            key: 'axis',
            domain: 'sample',
            size: 3,
            accepts: Uint8Array.of(1, 0, 1)
        });
        const axisFiltered = bins();

        events();
        assert.deepEqual(axisFiltered, bins(), `${label} with an axis filter`);
        axisViewport.filter.remove('axis');
    }
});

//
// Allocation attribute rows: allocationAttributeRows, binAllocationAttribute, viewportAllocationAttribute
//

test('allocation attribute rows take dictionary order, entry colors and whole-line totals', async () => {
    const { profile, line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([16, 32, 48, 64])
    });
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown };
    const spaces = [
        { code: 'new', name: 'new_space', color: '#101010' },
        { code: 'old', name: 'old_space', color: '#202020' }
    ];
    const owner = { scriptId: 1, start: 0 };
    const rows = () => line.attributes.map(attribute => methods.allocationAttributeRows.call(
        { context },
        attribute.name
    ));
    const expected = [
        [
            { index: 0, entry: 'array', color: typeColor.array, value: 80 },
            { index: 1, entry: 'string', color: typeColor.string, value: 80 }
        ],
        [
            { index: 0, entry: spaces[0], color: '#101010', value: 48 },
            { index: 1, entry: spaces[1], color: '#202020', value: 112 }
        ],
        [
            { index: 0, entry: null, color: 'green', value: 16 },
            { index: 1, entry: owner, color: 'green', value: 144 }
        ]
    ];

    line.attributes = [
        {
            name: 'allocationType',
            keys: Uint32Array.of(0, 1, 1, 0),
            entries: dictEntries(['array', 'string']),
            dict: ['array', 'string']
        },
        {
            name: 'allocationSpace',
            keys: Uint32Array.of(1, 1, 0, 1),
            entries: dictEntries(spaces),
            dict: spaces
        },
        {
            name: 'allocationOwner',
            keys: Uint32Array.of(0, 1, 1, 1),
            entries: dictEntries([null, owner]),
            dict: [null, owner]
        }
    ];
    assert.deepEqual(rows(), expected);

    // Rows don't follow the viewport or filters
    breakdown.populationViewport.setRanges([{ start: 0, end: 20 }]);
    breakdown.populationWindow.setRanges([{ start: 0, end: 20 }]);
    breakdown.populationWindow.filter.set({
        key: 'test',
        domain: 'event',
        size: 4,
        accepts: Uint8Array.of(0, 0, 0, 0)
    });
    assert.deepEqual(rows(), expected);
});

test.each([
    'binAllocationAttribute',
    'allocationAttributeRows',
    'viewportAllocationAttribute'
] as const)('%s gives no rows without a memline or for an unknown attribute', async method => {
    const timeline = await createContext();
    const memline = await createContext({ type: 'memline' });

    memline.scopeLine.attributes = [{ name: 'allocationType', keys: new Uint32Array(3), entries: dictEntries(['array']), dict: ['array'] }];
    assert.deepEqual(methods[method].call({ context: timeline }, 'allocationType'), []);
    assert.deepEqual(methods[method].call({ context: memline }, 'allocationSpace'), []);
});

test('allocationAttributeRows gives no rows for a memline without populations', async () => {
    const context = await createContext({ type: 'memline' });

    context.scopeLine.attributes = [{ name: 'allocationType', keys: new Uint32Array(3), entries: dictEntries(['array']), dict: ['array'] }];
    context.scopeLine.breakdowns = [];
    assert.deepEqual(methods.allocationAttributeRows.call({ context }, 'allocationType'), []);
});

// Allocations of 3 and 4 bytes have no mapping to CPU samples: byte offsets are no positions on the timeline
test.each([
    { method: 'binAllocationAttribute', expected: [] },
    { method: 'viewportAllocationAttribute', expected: [] },
    { method: 'allocationAttributeColumnMax', expected: null }
] as const)('$method gives nothing on a timeline the memline has no mapping to', async row => {
    const context = await createContext();
    const { line: memline } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([3, 4])
    });

    memline.attributes = [{ name: 'allocationType', keys: new Uint32Array(2), entries: dictEntries(['array']), dict: ['array'] }];
    Object.assign(context.scopeProfile, { memline });

    assert.deepEqual(methods[row.method].call({ context }, 'allocationType'), row.expected);
});

test('column maximums of an attribute are of the line viewport at a column duration, not of a window', async () => {
    const { profile, line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([16, 32, 48, 64])
    });
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown };
    const windowContext = { ...context, scopeViewport: { start: 0, end: 20 } };
    const columnMax = (columnContext: typeof context) => methods.allocationAttributeColumnMax.call(
        { context: columnContext },
        'allocationType'
    );
    const read = (max: ReturnType<typeof columnMax>, duration: number, origin = 0) => [
        max!.total(duration, origin),
        [max!.track(0)(duration, origin), max!.track(1)(duration, origin)]
    ];

    line.attributes = [{
        name: 'allocationType',
        keys: Uint32Array.of(0, 1, 1, 0),
        entries: dictEntries(['array', 'string']),
        dict: ['array', 'string']
    }];

    const initial = columnMax(context);

    // Columns of [0, 80) and [80, 160) hold 16 + 64 bytes of each type
    assert.deepEqual(read(initial, 80), [80, [64, 64]]);
    assert.deepEqual(read(initial, 20), [20, [20, 20]]);
    // Columns from 40 hold 16, 24 and 40 bytes of one type and 24, 56 and 0 of the other one
    assert.deepEqual(read(initial, 80, 40), [80, [40, 56]]);

    // Neither the window population nor a window as the scope viewport change them
    breakdown.populationWindow.setRanges([{ start: 0, end: 20 }]);
    assert.deepEqual(read(columnMax(windowContext), 80), [80, [64, 64]]);

    // A new viewport gives new maximums, also to the functions taken before it
    line.viewport.setRange(0, 48);
    breakdown.populationViewport.setRanges([{ start: 0, end: 48 }]);
    assert.deepEqual(read(columnMax(context), 80), [48, [16, 32]]);
    assert.deepEqual(read(initial, 80, 40), [40, [16, 24]]);
    assert.equal(methods.allocationAttributeColumnMax.call({ context }, 'allocationSpace'), null);
});

//
// Timestamp streams: heap events and function codes
//

test.each([
    {
        name: 'the viewport grid with missing coverage around the line',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        initial: 100,
        events: heapEvents([[130, 'new', 10], [140, 'delete', 10]]),
        added: [0, 0, 10, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 100, 0, 0, 0, 0, 0]
    },
    {
        name: 'the line viewport with boundary and final events',
        options: {},
        scopeViewport: null,
        count: 5,
        initial: 100,
        events: heapEvents([[130, 'new', 10], [140, 'delete', 10], [150, 'new', 20]]),
        added: [10, 0, 0, 0, 20],
        total: [110, 110, 110, 100, 120]
    },
    {
        name: 'final events of an offset population',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        initial: 100,
        events: heapEvents([[130, 'new', 10], [150, 'new', 10], [225, 'new', 10]]),
        added: [0, 0, 10, 0, 10, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 120, 120, 120, 120, 120, 120]
    },
    {
        name: 'no events',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        initial: 100,
        events: heapEvents([]),
        added: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 100, 100, 100, 0, 0, 0, 0, 0]
    },
    {
        name: 'a viewport after an earlier peak',
        options: { origin: 0, values: new Uint32Array([1000]) },
        scopeViewport: { start: 400, end: 500 },
        count: 4,
        initial: 0,
        events: heapEvents([[10, 'new', 1000], [300, 'delete', 900], [425, 'new', 20], [450, 'delete', 10]]),
        added: [20, 0, 0, 0],
        total: [120, 120, 110, 110]
    },
    {
        name: 'events at the viewport start',
        options: {},
        scopeViewport: { start: 130, end: 140 },
        count: 2,
        initial: 100,
        events: heapEvents([[120, 'new', 50], [130, 'delete', 30], [130, 'new', 10]]),
        added: [10, 0],
        total: [150, 130]
    },
    {
        name: 'an event at the viewport end, whose bin end is rounded below it',
        options: { origin: 0, values: new Uint32Array([100]) },
        scopeViewport: { start: 10, end: 15 },
        count: 3,
        initial: 0,
        events: heapEvents([[15, 'new', 7]]),
        added: [0, 0, 7],
        total: [0, 0, 7]
    },
    {
        name: 'a leading event without a timestamp',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        initial: 100,
        events: heapEvents([[0, 'new', 50], [130, 'new', 10]]),
        added: [0, 0, 10, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 110, 0, 0, 0, 0, 0]
    },
    {
        name: 'events after samples',
        options: { origin: 0, after: 75 },
        scopeViewport: { start: 0, end: 100 },
        count: 4,
        initial: 100,
        events: heapEvents([[75, 'new', 20]]),
        added: [0, 0, 20, 0],
        total: [100, 100, 120, 120]
    },
    {
        name: 'an event after the end of the line',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        initial: 100,
        events: heapEvents([[130, 'new', 10], [170, 'new', 20]]),
        added: [0, 0, 10, 0, 0, 0, 20, 0, 0, 0],
        total: [0, 0, 110, 110, 110, 110, 130, 0, 0, 0]
    },
    {
        name: 'a viewport after the line',
        options: {},
        scopeViewport: { start: 300, end: 400 },
        count: 4,
        initial: 100,
        events: heapEvents([[130, 'new', 10]]),
        added: [0, 0, 0, 0],
        total: [0, 0, 0, 0]
    }
])('heap events and heap total on $name', async row => {
    const context = await createContext(row.options, row.scopeViewport);
    const added = methods.binHeapEvents.call({ context }, row.events, 'new', row.count);
    const total = methods.binHeapTotal.call({ context }, row.events, row.count, row.initial);

    assert.deepEqual(Array.from(added), row.added);
    assert.deepEqual(Array.from(total), row.total);
});

test('heap total accepts a null resolved viewport when the line is explicit', async () => {
    const { scopeLine } = await createContext();
    const total = methods.binHeapTotal.call({ context: {} }, heapEvents([[130, 'new', 10]]), 5, 100, scopeLine);

    assert.deepEqual(Array.from(total), [110, 110, 110, 110, 110]);
});

test.each([
    {
        name: 'the viewport grid with missing coverage around the line',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        codes: functionCodes([[5, 'Ignition', 0]]),
        compilations: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        functions: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        tiers: { Ignition: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0] }
    },
    {
        name: 'a tier change at the end of the line',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0]]),
        compilations: [0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
        functions: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        tiers: {
            Ignition: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
            Sparkplug: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0]
        }
    },
    {
        name: 'the line viewport with tier changes at bin boundaries',
        options: {},
        scopeViewport: null,
        count: 5,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0]]),
        compilations: [1, 0, 0, 0, 1],
        functions: [1, 1, 1, 1, 1],
        tiers: { Ignition: [1, 1, 1, 1, 0], Sparkplug: [0, 0, 0, 0, 1] }
    },
    {
        name: 'final events of an offset population',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0], [100, 'Ignition', 0]]),
        compilations: [0, 0, 1, 0, 1, 1, 1, 1, 1, 1],
        functions: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
        tiers: {
            Ignition: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
            Sparkplug: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]
        }
    },
    {
        name: 'no codes',
        options: {},
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        codes: functionCodes([]),
        compilations: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        functions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tiers: {}
    },
    {
        name: 'a viewport after the history of a function',
        options: { origin: 100, values: new Uint32Array([1000]) },
        scopeViewport: { start: 500, end: 600 },
        count: 4,
        codes: functionCodes([[10, 'Ignition', 0], [300, 'Sparkplug', 0], [425, 'Ignition', 1]]),
        compilations: [1, 1, 1, 1],
        functions: [2, 2, 2, 2],
        tiers: { Ignition: [1, 1, 1, 1], Sparkplug: [1, 1, 1, 1] }
    },
    {
        name: 'a viewport after all codes',
        options: { origin: 100, values: new Uint32Array([1000]) },
        scopeViewport: { start: 500, end: 600 },
        count: 4,
        codes: functionCodes([[10, 'Ignition', 0], [300, 'Sparkplug', 0]]),
        compilations: [0, 0, 0, 0],
        functions: [1, 1, 1, 1],
        tiers: { Sparkplug: [1, 1, 1, 1] }
    },
    {
        name: 'a code at the viewport start',
        options: {},
        scopeViewport: { start: 130, end: 140 },
        count: 2,
        codes: functionCodes([[5, 'Ignition', 0]]),
        compilations: [1, 1],
        functions: [1, 1],
        tiers: { Ignition: [1, 1] }
    },
    {
        name: 'a code at the viewport end, whose bin end is rounded below it',
        options: { origin: 0, values: new Uint32Array([100]) },
        scopeViewport: { start: 10, end: 15 },
        count: 3,
        codes: functionCodes([[15, 'Ignition', 0]]),
        compilations: [0, 0, 1],
        functions: [0, 0, 1],
        tiers: { Ignition: [0, 0, 1] }
    },
    {
        name: 'codes after samples',
        options: { origin: 0, after: 75 },
        scopeViewport: { start: 0, end: 100 },
        count: 4,
        codes: functionCodes([[75, 'Ignition', 0]]),
        compilations: [0, 0, 1, 1],
        functions: [0, 0, 1, 1],
        tiers: { Ignition: [0, 0, 1, 1] }
    }
])('function compilations and states on $name', async row => {
    const context = await createContext(row.options, row.scopeViewport);
    const compilations = methods.binScriptFunctionCodes.call({ context }, row.codes, row.count);
    const states = methods.binScriptFunctionCodesTotal.call({ context }, row.codes, row.count);
    // Tiers without functions are omitted
    const tiers: Record<string, number[]> = {};

    for (let i = 0; i < states.byTier.length; i++) {
        const [tier, bins] = states.byTier[i];

        if (bins.some(count => count > 0)) {
            tiers[tier] = Array.from(bins);
        }
    }

    assert.deepEqual(Array.from(compilations), row.compilations);
    assert.deepEqual(Array.from(states.fnCount), row.functions);
    assert.deepEqual(tiers, row.tiers);
});

//
// Costs
//

test('reads viewport properties outside allocation and counter event loops', async () => {
    const context = await createContext();
    const { source, viewport: sourceViewport } = await createMappedSource(
        context.scopeLine,
        new Uint32Array(3000).fill(1),
        Uint32Array.from({ length: 3000 }, (_, i) => Math.floor(i / 1000)),
        new Uint32Array(3000)
    );
    const ownContext = {
        scopeLine: source,
        scopeBreakdown: source.breakdowns[0],
        scopeViewport: { start: 0, end: 3000 }
    };
    const reads: Map<string, number> = new Map();
    const countReads = (viewport: PopulationFiltered, key: string, name: string) => {
        const value = viewport[key as keyof PopulationFiltered];

        Object.defineProperty(viewport, key, {
            get() {
                reads.set(name, (reads.get(name) ?? 0) + 1);

                return value;
            }
        });
    };

    for (const key of ['samples', 'values', 'sinkId', 'cumulative', 'ranges']) {
        countReads(sourceViewport, key, `source.${key}`);
        countReads(context.scopeBreakdown.populationWindow, key, `axis.${key}`);
    }

    for (const compute of [
        () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10),
        () => methods.binLineToAxisLine.call({ context: ownContext }, source, null, source, 10),
        () => methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10),
        () => methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10),
        () => samplesMethods.countSamples.call({ context }, 10)
    ]) {
        reads.clear();
        compute();

        assert.deepEqual([...reads].filter(entry => entry[1] > 2), []);
    }
});

// Bin records are kept until the window changes (population.md), so aggregations over a recorded grid with other
// groups and filter selections read the events crossing bin edges, two edge events and the events of two binary
// searches of the mapping, rather than every event
test.each([1, 10])('aggregations over a recorded grid read events only at its edges (%i bins)', async count => {
    const length = 3000;
    const context = await createContext({
        origin: 0,
        values: new Uint32Array(30).fill(10),
        samples: new Uint32Array(30)
    }, { start: 0, end: 300 });
    const axis = context.scopeLine;
    const { source, viewport } = await createMappedSource(
        axis,
        Uint32Array.from({ length }, (_, i) => 1 + i % 5),
        Uint32Array.from({ length }, (_, i) => Math.floor(i / 100)),
        Uint32Array.from({ length }, (_, i) => i % 4)
    );
    const [breakdown] = source.breakdowns;
    const types = Uint32Array.from({ length }, (_, i) => i % 3);
    const attribute = {
        name: 'allocationType' as const,
        keys: types,
        entries: dictEntries(['a', 'b', 'c']),
        dict: ['a', 'b', 'c']
    };
    const ownContext = {
        scopeLine: source,
        scopeBreakdown: breakdown,
        scopeViewport: { start: 0, end: viewport.cumulativeEnd }
    };
    const aggregations = [
        (grouping: typeof attribute | null) => methods.binLineToAxisLine.call(
            { context: ownContext },
            source,
            grouping,
            source,
            count
        ),
        (grouping: typeof attribute | null) => methods.binLineToAxisLine.call(
            { context },
            source,
            grouping,
            axis,
            count
        )
    ];
    const selectTypes = (accepts: Uint8Array) => {
        for (const population of [breakdown.populationViewport, breakdown.populationWindow]) {
            population.filter.set({
                key: 'type',
                domain: 'event',
                size: length,
                values: types,
                accepts
            });
        }
    };
    let reads = 0;
    const counted = (vector: Uint32Array) => new Proxy(vector, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads++;
            }

            const value = Reflect.get(target, property, target);

            return typeof value === 'function' ? value.bind(target) : value;
        }
    });

    source.attributes = [attribute];
    selectTypes(Uint8Array.of(1, 1, 1));
    source.signatures = new EventSignatures(source);
    axis.signatures = new EventSignatures(axis);

    for (const aggregate of aggregations) {
        aggregate(attribute);
    }

    viewport.population.values = counted(viewport.population.values);
    source.values = viewport.population.values;
    source.mappings.timeline._mapping = counted(source.mappings.timeline._mapping);
    selectTypes(Uint8Array.of(1, 0, 1));

    for (const aggregate of aggregations) {
        reads = 0;
        aggregate(null);
        assert.ok(reads <= count + 2 + 2 * Math.ceil(Math.log2(length + 1)), `${reads} event reads`);
    }
});

test('seeks sparse ranges without reading event weights in the gaps', async () => {
    const length = 100_000;
    const context = await createContext({
        origin: 0,
        samples: new Uint32Array(length),
        values: new Uint32Array(length).fill(10)
    }, { start: 0, end: length * 10 });
    const { population: base, populationWindow: viewport } = context.scopeBreakdown;
    let reads = 0;

    viewport.setRanges([{ start: 100, end: 200 }, { start: 900_000, end: 900_100 }]);
    // Values are compiled when first read, before reads are counted
    viewport.values;
    base.values = new Proxy(base.values, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                const index = Number(property);
                const inFirstRange = index >= 10 && index < 20;
                const inSecondRange = index >= 90_000 && index < 90_010;

                reads++;
                assert.ok(inFirstRange || inSecondRange, `Read gap event ${index}`);
            }

            return Reflect.get(target, property, target);
        }
    });
    context.scopeLine.values = base.values;

    for (const compute of [
        () => methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 500),
        () => methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 500),
        () => samplesMethods.countSamples.call({ context }, 500),
        () => samplesMethods.countSamplesDiscrete.call({ context }, 500, undefined)
    ]) {
        reads = 0;
        compute();
        // Visible events are read once; the four edge events up to twice more, for their acceptance and their weight
        assert.ok(reads <= 20 + 2 * 4, `${reads} weight reads for 20 visible events`);
    }
});

test.skipIf(!process.env.CPUPRO_BIN_BENCH)('measures viewport binning on seven million allocations', async () => {
    const length = 7_000_000;
    const context = await createContext({
        origin: 0,
        samples: new Uint32Array(70_000),
        values: new Uint32Array(70_000).fill(100)
    }, { start: 0, end: length });
    const axis = context.scopeLine;
    const { source, viewport } = await createMappedSource(
        axis,
        new Uint32Array(length).fill(1),
        Uint32Array.from({ length }, (_, i) => Math.floor(i / 100)),
        Uint32Array.from({ length }, (_, i) => i % 16)
    );
    const base = viewport.population;
    const [ownBreakdown] = source.breakdowns;
    const ownContext = {
        scopeLine: source,
        scopeBreakdown: ownBreakdown,
        scopeViewport: context.scopeViewport
    };
    const dict = Array.from({ length: 16 }, (_, i) => String(i));
    const attribute = { name: 'allocationType', keys: base.samples, entries: dictEntries(dict), dict } as const;
    const mask = new Uint8Array(16).fill(1);
    const categories = ownBreakdown.categories!.all.nodes;
    const ranges = Array.from({ length: 32 }, (_, i) => ({ start: i * 200_000 + 1000, end: i * 200_000 + 2000 }));
    const own = (n: number) => methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, undefined, n);
    const legacyCategories = () => categories.tree.dictionary.map(entry => ({
        self: methods.binCalls.call({ context: ownContext }, categories, entry, 500),
        nested: methods.binCallsFromMask.call(
            { context: ownContext },
            treeMethods.subtreeSamples(categories, entry).mask,
            500
        )
    }));
    const results: { name: string; constrained: boolean; medianMs: number }[] = [];

    for (const constrained of [false, true]) {
        if (constrained) {
            const accepts = new Uint8Array(viewport.samplesMask.length).fill(1);

            accepts[0] = 0;
            viewport.filter.set({
                key: 'samples',
                domain: 'sample',
                size: accepts.length,
                accepts
            });
            viewport.setRanges(ranges);
        }

        const totals = viewport.aggregateBy(attribute.keys, attribute.dict.length).samplesTotal;

        assert.deepEqual(Array.from(totals), own(1).map(row => row.value));

        for (const [name, compute] of [
            ['mapped', () => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 500)],
            ['own', () => own(500)],
            ['own-summary', () => own(1)],
            ['totals', () => viewport.aggregateBy(attribute.keys, attribute.dict.length)],
            ['categories', () => methods.binTreeSamples.call({ context: ownContext }, categories, 500)],
            ['categories-legacy', legacyCategories],
            ['samples', () => methods.binCallsFromMask.call({ context: ownContext }, mask, 500)],
            ['counts', () => samplesMethods.countSamples.call({ context: ownContext }, 500)]
        ] as const) {
            compute();
            const timings = Array.from({ length: 5 }, () => {
                const start = performance.now();

                compute();

                return performance.now() - start;
            }).sort((left, right) => left - right);

            results.push({ name, constrained, medianMs: Number(timings[2].toFixed(2)) });
        }
    }

    process.stdout.write(JSON.stringify(results) + '\n');
}, 60_000);
