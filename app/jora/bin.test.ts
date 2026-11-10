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
import { createLineFixture } from '../../test/fixtures/profile.js';
import { createLineMapping } from '../prepare/computations/line-mapping.js';
import { EventSignatures } from '../prepare/lines/event-signatures.js';
import { PopulationFiltered } from '../prepare/computations/population.js';

type HeapEvents = Parameters<typeof methods.binHeapTotal>[0];
type FunctionCodes = Parameters<typeof methods.binScriptFunctionCodesTotal>[0];

const query = jora.setup({ methods: { ...methods, ...samplesMethods, ...profileMethods } });
const category = { name: 'script' };
const idle = { name: 'idle' };

// Events at 125–150 by default (values 10, 10, 5 of sample IDs 0, 1, 0), scoped to the viewport 100–200
async function createContext(options: Parameters<typeof createLineFixture>[0] = {}, scopeViewport: Range | null = { start: 100, end: 200 }) {
    const { profile, line, breakdown } = await createLineFixture({ origin: 125, ...options });

    return { scopeViewport, scopeLine: line, scopeProfile: profile, scopeBreakdown: breakdown };
}

async function createMappedSource(axis: ProfileLine, values = new Uint32Array([3, 4, 5]), mapping = new Uint32Array([0, 1, 2]), samples = Uint32Array.from(values, (_, index) => index)) {
    const { line: source, breakdown } = await createLineFixture({ type: 'memline', values, samples });
    const { left, right } = createLineMapping(source, Array.from(mapping), axis, Array.from({ length: axis.values.length }, (_, index) => index));

    source.mappings[axis.type] = left;
    axis.mappings[source.type] = right;

    return { source, viewport: breakdown.populationViewport };
}

function createTree(dictionary: string[], nodes: Uint32Array, parent: Uint32Array) {
    const subtree = subtreeFromParent(parent);

    return new CallTree(dictionary, nodes, parent, subtree, nestedFromNodesSubtree(nodes, subtree, dictionary.length));
}

// Metrics of a tree whose node N is entry N
function createFlatMetrics(dictionary: unknown[], sampleToNode: Uint32Array) {
    return {
        tree: { dictionary, nodes: Uint32Array.from(dictionary, (_, index) => index) },
        sampleToNode
    };
}

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % max;
}

function overlap(start: number, end: number, from: number, to: number) {
    return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

function assertClose(actual: ArrayLike<number>, expected: ArrayLike<number>) {
    assert.equal(actual.length, expected.length);

    for (let index = 0; index < expected.length; index++) {
        assert.ok(Math.abs(actual[index] - expected[index]) < 1e-8, `bin ${index}: ${actual[index]} instead of ${expected[index]}`);
    }
}

function heapEvents(events: [tm: number, event: 'new' | 'delete', size: number][]) {
    return events.map(([tm, event, size]) => ({ tm, event, size })) as HeapEvents;
}

// Codes of functions numbered by the identity of their call frame codes
function functionCodes(codes: [tm: number, tier: string, fn: number][]) {
    const functions: object[] = [];
    const result: { tm: number; tier: string; callFrameCodes: object }[] = [];

    for (const [tm, tier, fn] of codes) {
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

    assert.equal(query('500.binCount()')({}, context), 100);
    assert.equal(query('500.binCount(scopeViewport())')({}, context), 100);
    assert.equal(query('500.binCount(missing)')({}, context), 100);
    assert.equal(query('500.binCount()')({}, nested), 5);
    assert.equal(query('500.binCount(0)')({}, nested), 1);
    assert.equal(query('500.binCount({ start: 0, end: 30 })')({}, nested), 30);
    assert.equal(query('500.binCount()')({}, { ...context, scopeViewport: null }), 25);
    assert.equal(query('500.binCount()')({}, { ...context, scopeViewport: null, data: { profiles: [other.profile] } }), 200);
});

//
// Sample bins: binCallsFromMask, binCalls and binSignals (of the whole recording)
//

test.each([
    { name: 'the scope viewport', scopeViewport: { start: 100, end: 200 }, profiles: [] as Uint32Array[], expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0] },
    { name: 'the viewport of all profiles', scopeViewport: null, profiles: [new Uint32Array([100])], expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0] },
    { name: 'a nested scope viewport', scopeViewport: { start: 125, end: 150 }, profiles: [new Uint32Array([100])], expected: [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5] },
    { name: 'the line viewport', scopeViewport: null, profiles: [] as Uint32Array[], expected: [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5] }
])('sample and category bins of a short population are placed on $name', async ({ scopeViewport, profiles, expected }) => {
    const others = await Promise.all(profiles.map(async values => (await createLineFixture({ origin: 100, values })).profile));
    const context = { ...await createContext({}, scopeViewport), data: { profiles: others } };
    const metrics = createFlatMetrics([category, idle], new Uint32Array([0, 1]));

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 10), expected);
    assert.deepEqual(Array.from(methods.binCalls.call({ context }, metrics, category, 10)), expected);
});

test.each([
    { name: 'a whole line of 101', options: { origin: 0, values: new Uint32Array([101]) }, scopeViewport: { start: 0, end: 101 }, expected: [11, 11, 11, 11, 11, 11, 11, 11, 11, 2] },
    { name: 'a whole line of 25', options: { origin: 0, values: new Uint32Array([25]) }, scopeViewport: { start: 0, end: 25 }, expected: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5] },
    { name: 'a whole line of 27', options: { origin: 0, values: new Uint32Array([27]) }, scopeViewport: { start: 0, end: 27 }, expected: [2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7] },
    { name: 'an offset population', options: {}, scopeViewport: { start: 100, end: 201 }, expected: [0, 0, 8, 11, 6, 0, 0, 0, 0, 0] },
    { name: 'a viewport inside an event', options: { origin: 0, values: new Uint32Array([1000]) }, scopeViewport: { start: 400, end: 501 }, expected: [11, 11, 11, 11, 11, 11, 11, 11, 11, 2] }
])('sample bins over $name take the rounded step only when its excess stays within the last bin', async ({ options, scopeViewport, expected }) => {
    const context = await createContext(options, scopeViewport);

    assertClose(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10), expected);
});

test.each([
    [130, 140, [5, 0]],
    [120, 130, [0, 5]],
    [145, 155, [5, 0]],
    [100, 110, [0, 0]],
    [160, 170, [0, 0]]
] as const)('clips sample intervals to viewport [%i, %i] without changing source values', async (start, end, expected) => {
    const context = await createContext({}, { start, end });
    const values = context.scopeLine.values.slice();

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 2), expected);
    assert.deepEqual(context.scopeLine.values, values);
});

test.each([101, 1001, 4961966])('bounds ruler approximation without removing integer binning for total=%i', async total => {
    const count = Math.min(500, total);
    const { breakdown } = await createLineFixture({ values: new Uint32Array([total]) });
    const context = { scopeBreakdown: breakdown };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1]), count);
    const state = createState(total, count);
    let boundary = 0;

    for (let index = 0; index < count; index++) {
        const selection = selectRange(state, (index + 0.1) / count, (index + 0.9) / count);

        assert.ok(Math.abs(boundary - selection.start) < Math.ceil(total / count));
        boundary += bins[index];
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
    const metrics = createFlatMetrics([{}], new Uint32Array([0, 0]));
    const options = { n: 10, total: 101, skip: 25 };
    const expected = [0, 0, 8, 11, 6, 0, 0, 0, 0, 0];

    assert.deepEqual(Array.from(methods.binSignals.call({ context }, metrics, options)), expected);
    assert.deepEqual(Array.from(methods.binSignals.call({ context: { ...context, scopeViewport: null } }, metrics, options)), expected);
});

test.each((['timeline', 'memline'] as const).flatMap(type => [
    { type, label: 'whole', ranges: null, expected: [0, 0, 5, 5, 5, 0, 0, 0, 0, 0] },
    { type, label: 'disjoint ranges', ranges: [{ start: 1, end: 8 }, { start: 12, end: 14 }, { start: 21, end: 24 }], expected: [0, 0, 4, 3, 3, 0, 0, 0, 0, 0] }
]))('category bins on a $type ignore a sink overlapping unused tree samples ($label)', async ({ type, ranges, expected }) => {
    const context = await createContext({ type });
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

    viewport.setRanges(ranges);
    assert.deepEqual(bins(), [expected, expected]);

    for (const filter of [
        { key: 'category', domain: 'sample', size: 2 },
        { key: 'category', domain: 'event', size: 3, values: viewport.population.samples }
    ] as const) {
        viewport.filter.set({ ...filter, accepts: Uint8Array.of(1, 0) });
        assert.deepEqual(bins(), [expected, expected]);
        viewport.filter.set({ ...filter, accepts: Uint8Array.of(0, 0) });
        assert.deepEqual(bins(), [empty, empty]);
        viewport.filter.remove('category');
        assert.deepEqual(bins(), [expected, expected]);
    }

    assert.deepEqual([...mask], [1, 0, 1, 0]);
});

test.each([0, 1, 7, 0xffffffff].flatMap(sinkId => [
    { sinkId, label: 'whole', ranges: null, expected: [0, 0, 5, 5, 5, 5, 0, 0] },
    { sinkId, label: 'disjoint ranges', ranges: [{ start: 2, end: 17 }, { start: 23, end: 38 }], expected: [0, 0, 5, 2, 2, 5, 0, 0] }
]))('binning excludes sink ID $sinkId without excluding other sample IDs ($label)', async ({ sinkId, ranges, expected }) => {
    const context = await createContext({
        type: 'memline',
        origin: 0,
        values: new Uint32Array([10, 10, 10, 10]),
        samples: new Uint32Array([2, 2, 3, 3])
    }, { start: 0, end: 40 });
    const viewport = context.scopeBreakdown.populationWindow;
    const metrics = createFlatMetrics([category], new Uint32Array(8));
    const mask = new Uint8Array(8).fill(1);

    viewport.setRanges(ranges);
    Object.defineProperty(viewport, 'sinkId', { value: sinkId });
    viewport.samples.set([sinkId, 2, 3, sinkId]);

    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 8), expected);
    assert.deepEqual(Array.from(methods.binCalls.call({ context }, metrics, category, 8)), expected);
    assert.deepEqual([...mask], new Array(8).fill(1));
});

test('viewport bins and counters preserve coordinates, disjoint coverage and source filter acceptance', async () => {
    const context = await createContext();
    const viewport = context.scopeBreakdown.populationWindow;
    const selection = context.scopeBreakdown.populationFiltered;
    const mask = new Uint8Array([1, 1]);
    const empty = new Array(10).fill(0);

    viewport.filter.set({ key: 'sample', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 0) });
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, 10)], [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);

    // Selection constraints don't apply to histograms
    selection.setRange(20, 25);
    selection.filter.set({ key: 'selection', domain: 'sample', size: 2, accepts: new Uint8Array(2) });
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);

    viewport.filter.remove('sample');
    viewport.setRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 8, end: 12 }, { start: 21, end: 24 }]);
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 2, 4, 3, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, 10)], [0, 0, 1, 2, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamplesDiscrete.call({ context }, 10, undefined)], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

    viewport.setRanges([]);
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), empty);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, 10)], empty);
});

test.each([
    [5, [0, 10, 10, 0, 0]],
    [1, [20]]
])('sample, own allocation and tree bins in %i bins skip events an index constraint leaves without weight', async (count, expected) => {
    const context = await createContext({ origin: 0, values: new Uint32Array([10, 10, 10, 10, 10]), samples: new Uint32Array(5) }, { start: 0, end: 50 });
    const viewport = context.scopeBreakdown.populationWindow;
    const line = context.scopeLine;
    const metrics = { tree: createTree(['all'], new Uint32Array([0]), new Uint32Array([0])), sampleToNode: new Uint32Array([0]) };

    // Range edges cut the first and the last events, which the constraint leaves without weight
    viewport.setRanges([{ start: 5, end: 45 }]);
    viewport.setIndexRange(1, 3);

    const [own] = methods.binLineToAxisLine.call({ context }, line, null, line, count);
    const [tree] = methods.binTreeSamples.call({ context }, metrics, count);

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1]), count), expected);
    assert.deepEqual([...own.bins], expected);
    assert.equal(own.value, 20);
    assert.deepEqual([...tree.bins], expected);
    assert.equal(tree.value, 20);
});

test('clipped sample bins match scalar intersections across masks, offsets and bin counts', async () => {
    const values = new Uint32Array([0, 10, 270, 5, 400, 315]);
    const samples = new Uint32Array([0, 1, 0, 1, 1, 0]);
    const context = await createContext({ origin: 0, values, samples });
    const metrics = createFlatMetrics([0, 1], new Uint32Array([0, 1]));

    for (const [start, end] of [[-50, 150], [110, 211], [250, 400], [900, 1050], [1200, 1301]]) {
        for (const count of [1, 3, 10]) {
            for (const mask of [new Uint8Array([1, 0]), new Uint8Array([1, 1])]) {
                const total = end - start;
                // The rounded step when its excess over the total stays within the last bin
                const rounded = Math.ceil(total / count);
                const step = rounded * count - total < rounded ? rounded : total / count;
                const expected = new Float64Array(count);

                for (let index = 0, offset = 0; index < values.length; index++) {
                    if (mask[samples[index]] === 1) {
                        for (let binIndex = 0; binIndex < count; binIndex++) {
                            expected[binIndex] += overlap(offset, Math.min(offset + values[index], end), start + binIndex * step, start + (binIndex + 1) * step);
                        }
                    }

                    offset += values[index];
                }

                assertClose(methods.binSignals.call({ context }, metrics, {
                    n: count, total, skip: -start, test: (entry: number) => mask[entry] === 1
                }), expected);
            }
        }
    }
});

test('matches scalar bins and counters across disjoint ranges without shifting filtered coordinates', async () => {
    const context = await createContext({ origin: 0, samples: new Uint32Array([0, 1, 0, 1, 1, 0, 0]), values: new Uint32Array([0, 10, 270, 5, 400, 315, 0]) });
    const { population: base, populationWindow: viewport } = context.scopeBreakdown;

    for (const ranges of [null, [], [{ start: 1, end: 19 }], [{ start: 25, end: 280 }],
        [{ start: 1, end: 4 }, { start: 6, end: 8 }, { start: 90, end: 300 }, { start: 701, end: 810 }]]) {
        viewport.setRanges(ranges);

        for (const filtered of [false, true]) {
            viewport.updateMask(mask => {
                mask[1] = filtered ? 1 : 0;
            });

            for (const [start, end] of [[0, 1000], [-30, 170], [900, 1100]]) {
                context.scopeViewport = { start, end };

                for (const count of [1, 4, 10]) {
                    const step = (end - start) / count;
                    const expected = new Float64Array(count);
                    const counts = new Uint32Array(count);
                    const discrete = new Uint32Array(count);

                    for (let index = 0; index < base.values.length; index++) {
                        if (base.values[index] === 0 || filtered && base.samples[index] === 1) {
                            continue;
                        }

                        const eventStart = base.cumulative[index];
                        const eventEnd = eventStart + base.values[index];

                        for (let binIndex = 0; binIndex < count; binIndex++) {
                            const binStart = start + binIndex * step;
                            const binEnd = binStart + step;
                            let contribution = 0;
                            let containsStart = false;

                            for (const range of ranges ?? [{ start: 0, end: 1000 }]) {
                                contribution += overlap(Math.max(eventStart, range.start), Math.min(eventEnd, range.end), binStart, binEnd);
                                containsStart ||= eventStart >= Math.max(range.start, binStart) && eventStart < Math.min(range.end, binEnd);
                            }

                            expected[binIndex] += contribution;
                            counts[binIndex] += contribution > 0 ? 1 : 0;
                            discrete[binIndex] += containsStart ? 1 : 0;
                        }
                    }

                    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), count), [...expected]);
                    assert.deepEqual([...methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, count)[0].bins], [...expected]);
                    assert.deepEqual(samplesMethods.countSamples.call({ context }, count), counts);
                    assert.deepEqual(samplesMethods.countSamplesDiscrete.call({ context }, count, undefined), discrete);
                }
            }
        }
    }
});

//
// Category tree bins: binTreeSamples
//

test('joint tree bins preserve self values and binary nested presence across viewport constraints', async () => {
    const context = await createContext({ origin: 0, values: new Uint32Array([0, 10, 270, 5, 400, 315]), samples: new Uint32Array([0, 1, 2, 3, 4, 5]) });
    const dictionary = ['root', 'A', 'B', 'C'];
    const tree = createTree(dictionary, new Uint32Array([0, 1, 2, 1, 3, 2, 3]), new Uint32Array([0, 0, 1, 2, 3, 0, 5]));
    const metrics = { tree, sampleToNode: new Uint32Array([0, 1, 2, 3, 4, 6]) };
    const viewport = context.scopeBreakdown.populationWindow;

    for (const ranges of [null, [], [{ start: 2, end: 9 }, { start: 12, end: 20 }, { start: 30, end: 280 }, { start: 700, end: 999 }]]) {
        viewport.setRanges(ranges);

        for (const filtered of [false, true]) {
            viewport.filter.set({ key: 'event', domain: 'event', size: 6, accepts: Uint8Array.from({ length: 6 }, (_, index) => Number(!filtered || index % 2 === 0)) });

            for (const [start, end] of [[0, 1000], [-50, 151], [20, 121], [900, 1100], [1200, 1300]]) {
                context.scopeViewport = { start, end };

                for (const count of [1, 3, 10, 500]) {
                    const actual = methods.binTreeSamples.call({ context }, metrics, count);

                    for (let index = 0; index < dictionary.length; index++) {
                        const entry = dictionary[index];
                        const self = methods.binCalls.call({ context }, metrics, entry, count);
                        const nested = methods.binCallsFromMask.call({ context }, treeMethods.subtreeSamples(metrics, entry).mask, count);

                        assertClose(actual[index].bins, self);
                        assert.deepEqual([...actual[index].nestedPresence], nested.map(value => Number(value > 1e-8)));
                        assertClose([actual[index].value], [self.reduce((sum, value) => sum + value, 0)]);
                    }
                }
            }
        }
    }
});

test.each([
    // root -> B -> A -> B, with self samples of A and the inner B
    { name: 'an entry inside a recursive entry', nodes: [0, 2, 1, 2], parent: [0, 0, 1, 2], expected: [1, 1, 1] },
    // root -> B -> (B, B), with self samples of both inner B
    { name: 'sibling subtrees of the same entry', nodes: [0, 2, 2, 2], parent: [0, 0, 1, 1], expected: [1, 0, 0] }
])('nested presence marks entries with other entries in their subtrees: $name', async ({ nodes, parent, expected }) => {
    const context = await createContext({ origin: 0, values: new Uint32Array([10, 10]), samples: new Uint32Array([0, 1]) }, { start: 0, end: 20 });
    const tree = createTree(['root', 'A', 'B'], new Uint32Array(nodes), new Uint32Array(parent));
    const rows = methods.binTreeSamples.call({ context }, { tree, sampleToNode: new Uint32Array([2, 3]) }, 1);

    assert.deepEqual(rows.map(row => [...row.nestedPresence]), expected.map(present => [present]));
});

test('nested presence preserves fractional contributions and excludes recursive self', async () => {
    const context = await createContext({ origin: 0, values: new Uint32Array([1]), samples: new Uint32Array([0]) }, { start: 0, end: 1e-9 });
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
    const context = await createContext({ origin: 0, values: new Uint32Array([1000]), samples: new Uint32Array([0]) }, { start: 0, end: 1000 });
    const nodes = Uint32Array.from({ length: 64 }, (_, index) => index % 3);
    const dictionary = ['a', 'b', 'c'];
    const tree = createTree(dictionary, nodes, Uint32Array.from(nodes, (_, index) => Math.max(0, index - 1)));
    const metrics = { tree, sampleToNode: new Uint32Array([63]) };
    const original = globalThis.Float64Array;
    let cells = 0;

    globalThis.Float64Array = new Proxy(original, { construct(target, args) {
        const array = Reflect.construct(target, args);

        cells += array.length;

        return array;
    } });

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

test('allocation row values summarize accepted contributions independently of display bins', async () => {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array([16, 32, 48, 64]),
        samples: new Uint32Array([0, 1, 1, 2])
    });
    const attribute = { name: 'allocationType' as const, values: new Uint32Array([0, 1, 1, 2]), dict: ['first', 'second', 'third'] };
    const context = { scopeLine: line, scopeBreakdown: breakdown, scopeViewport: null as Range | null };
    const rows = (count: number) => methods.binLineToAxisLine.call({ context }, line, attribute, line, count);

    for (const count of [1, 7, 50, 160]) {
        const result = rows(count);

        assert.deepEqual(result.map(row => row.value), [16, 80, 64]);
        assert.deepEqual(result.map(row => row.bins.length), [count, count, count]);
    }

    // A single bin of a viewport within the line takes its events only
    context.scopeViewport = { start: 0, end: 48 };
    for (const count of [1, 7]) {
        assert.deepEqual(rows(count).map(row => row.value), [16, 32, 0]);
    }

    context.scopeViewport = null;
    breakdown.populationWindow.setRanges([{ start: 1, end: 1.5 }, { start: 3, end: 3.5 }, { start: 20, end: 25 }]);
    for (const count of [1, 7, 50]) {
        assert.deepEqual(rows(count).map(row => row.value), [1, 5, 0]);
    }
});

test('full-event bin spans match scalar intersections across filters and fractional range cuts', async () => {
    const values = Uint32Array.from({ length: 512 }, (_, index) => index % 17 === 0 ? 0 : index % 7 + 1);
    const groups = Uint32Array.from(values, (_, index) => index % 3);

    values[128] = 1024;
    values[511] = 0;

    const { line, breakdown } = await createLineFixture({ type: 'memline', values, samples: groups });
    const { population: base, populationWindow: viewport } = breakdown;
    const context = { scopeLine: line, scopeBreakdown: breakdown, scopeViewport: { start: 0, end: 4096 } };
    const attributes = [null, ...[Uint8Array.from(groups), groups].map(values => ({ name: 'allocationType' as const, values, dict: ['a', 'b', 'c'] }))];

    for (const ranges of [null, [], [{ start: 1.125, end: 480.875 }, { start: 500.125, end: 700.875 }, { start: 900.125, end: 2500.875 }]]) {
        viewport.setRanges(ranges);

        for (const filtered of [false, true]) {
            viewport.filter.set({ key: 'event', domain: 'event', size: values.length, accepts: Uint8Array.from({ length: values.length }, (_, index) => Number(!filtered || index % 5 !== 0)) });

            for (const [start, end] of [[0, 4096], [-32.125, 4063.875], [992.125, 1248.125]]) {
                context.scopeViewport = { start, end };

                for (const count of [1, 2, 16, 64]) {
                    for (const attribute of attributes) {
                        const bins = Array.from({ length: attribute ? 3 : 1 }, () => new Uint32Array(count));
                        const totals = new Array(bins.length).fill(0);
                        const step = (end - start) / count;

                        // Uint32 bins truncate each addition, as accumulation by events and ranges does
                        for (const range of ranges ?? [{ start: 0, end: base.cumulativeEnd }]) {
                            for (let index = 0; index < values.length; index++) {
                                if (values[index] === 0 || filtered && index % 5 === 0) {
                                    continue;
                                }

                                const group = attribute ? groups[index] : 0;
                                const left = Math.max(base.cumulative[index], range.start, start);
                                const right = Math.min(base.cumulative[index] + values[index], range.end, end);

                                totals[group] += Math.max(0, right - left);
                                for (let binIndex = 0; binIndex < count; binIndex++) {
                                    bins[group][binIndex] += overlap(left, right, start + binIndex * step, start + (binIndex + 1) * step);
                                }
                            }
                        }

                        const actual = methods.binLineToAxisLine.call({ context }, line, attribute, line, count);

                        assert.deepEqual(actual.map(row => row.bins), bins);
                        assert.deepEqual(actual.map(row => row.value), totals);
                    }
                }
            }
        }
    }
});

//
// Allocation bins on a mapped axis: binLineToAxisLine
//

test('mapped single-bin totals preserve wide sums with and without groups', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine, new Uint32Array([0xffffffff, 5]), new Uint32Array([0, 1]), new Uint32Array([0, 0]));
    const attribute = { name: 'allocationType' as const, values: new Uint8Array([0, 0]), dict: ['all'] };

    for (const grouping of [null, attribute]) {
        const [row] = methods.binLineToAxisLine.call({ context }, source, grouping, context.scopeLine, 1);

        assert.equal(row.value, 2 ** 32 + 4);
        assert.deepEqual(row.bins, new Uint32Array([4]));
    }

    context.scopeBreakdown.populationWindow.filter.set({ key: 'test', domain: 'event', size: 3, accepts: Uint8Array.of(0, 1, 0) });
    for (const grouping of [null, attribute]) {
        const [row] = methods.binLineToAxisLine.call({ context }, source, grouping, context.scopeLine, 1);

        assert.equal(row.value, 5);
        assert.deepEqual(row.bins, new Uint32Array([5]));
    }
});

test('allocation mapping uses the axis viewport while retaining source totals', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);
    const [mapped] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);
    const [own] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10);

    assert.deepEqual(Array.from(mapped.bins), [0, 0, 3, 4, 5, 0, 0, 0, 0, 0]);
    assert.equal(mapped.total, 12);
    assert.deepEqual(Array.from(own.bins), [0, 0, 5, 10, 10, 0, 0, 0, 0, 0]);
    assert.equal(own.step, 10);
});

test.each([
    { name: 'outside a narrow viewport', scopeViewport: { start: 130, end: 140 }, count: 2, mapped: [0, 4], own: [5, 5] },
    { name: 'at the end of the viewport', scopeViewport: { start: 130, end: 145 }, count: 3, mapped: [0, 4, 0], own: [5, 5, 5] }
])('does not fold allocations mapped $name into the last bin', async ({ scopeViewport, count, mapped, own }) => {
    const context = await createContext({}, scopeViewport);
    const { source } = await createMappedSource(context.scopeLine);
    const [mappedRow] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, count);
    const [ownRow] = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, count);

    assert.deepEqual(Array.from(mappedRow.bins), mapped);
    assert.equal(mappedRow.value, 4);
    assert.deepEqual(Array.from(ownRow.bins), own);
});

test('allocation bins apply source and axis viewport participation without affecting their Base coordinates', async () => {
    const context = await createContext();
    const axis = context.scopeBreakdown.populationWindow;
    const { source, viewport } = await createMappedSource(context.scopeLine);
    const mapped = () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];

    viewport.setRange(1, 10);
    assert.deepEqual([...mapped().bins], [0, 0, 2, 4, 3, 0, 0, 0, 0, 0]);
    viewport.filter.set({ key: 'allocations', domain: 'event', size: 3, accepts: Uint8Array.of(1, 0, 1) });
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

test('mapped bins take axis participation from the scope breakdown of the axis line, otherwise from its first breakdown', async () => {
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

test('the window of a source line, a range of its own axis, does not narrow its bins on another axis', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);
    const mapped = () => [...methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0].bins];
    const ownContext = { ...context, scopeLine: source, scopeBreakdown: source.breakdowns[0], scopeViewport: undefined };
    const ownTotal = () => methods.binLineToAxisLine.call({ context: ownContext }, source, null, source, 12)[0].bins.reduce((sum, value) => sum + value, 0);
    const bins = mapped();

    assert.equal(ownTotal(), 12);
    // E.g. a memline window following a zoom synchronized through time, cells of halvings of the bytes extent
    source.breakdowns[0].populationWindow.setRanges([{ start: 3, end: 4 }]);
    assert.deepEqual(mapped(), bins);
    // On its own axis the window is the range of histogram data
    assert.equal(ownTotal(), 1);
    source.breakdowns[0].populationWindow.setRanges(null);
});

test.each([
    { name: 'a range inside one allocation and a later range', ranges: [{ start: 1, end: 2 }, { start: 4, end: 12 }], indexRange: [null, null], expected: [0, 0, 1, 3, 5, 0, 0, 0, 0, 0] },
    { name: 'edge allocations an index constraint leaves without weight', ranges: [{ start: 1, end: 10 }], indexRange: [1, 2], expected: [0, 0, 0, 4, 0, 0, 0, 0, 0, 0] }
] as const)('mapped allocation bins take source participation of $name', async ({ ranges, indexRange: [indexStart, indexEnd], expected }) => {
    const context = await createContext();
    const { source, viewport } = await createMappedSource(context.scopeLine);

    viewport.setRanges([...ranges]);
    viewport.setIndexRange(indexStart, indexEnd);

    const [row] = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10);

    assert.deepEqual([...row.bins], expected);
    assert.equal(row.value, expected.reduce((sum, value) => sum + value, 0));
});

test.each([
    { name: 'from the start of a range', ranges: [{ start: 10, end: 25 }], expected: [0, 0, 0, 4, 5, 0, 0, 0, 0, 0] },
    { name: 'not before a range they overlap', ranges: [{ start: 15, end: 25 }], expected: [0, 0, 0, 0, 5, 0, 0, 0, 0, 0] },
    { name: 'not at the end of a range', ranges: [{ start: 0, end: 10 }, { start: 12, end: 25 }], expected: [0, 0, 3, 0, 5, 0, 0, 0, 0, 0] }
])('mapped targets are placed by their start within axis ranges: $name', async ({ ranges, expected }) => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);

    context.scopeBreakdown.populationWindow.setRanges(ranges);
    assert.deepEqual([...methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0].bins], expected);
});

test('allocations of unmapped targets and of targets past the axis add nothing to mapped bins', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine, new Uint32Array([3, 4, 5, 6, 7]), new Uint32Array([0, 0, 0, 1, 2]));

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
])('mapped bins from $name visit only events with targets on the grid and match every event placed by its target', async ({ grouped }) => {
    const random = sequence(7);
    const axisValues = Uint32Array.from({ length: 40 }, () => 1 + random(9));
    const context = await createContext({ values: axisValues, samples: Uint32Array.from(axisValues, () => random(3)) });
    const axis = context.scopeLine;
    const targets = Uint32Array.from({ length: 300 }, () => random(axisValues.length)).sort();
    const { source, viewport } = await createMappedSource(axis, Uint32Array.from(targets, () => 1 + random(20)), targets, Uint32Array.from(targets, () => random(4)));
    const attribute = { name: 'allocationType' as const, values: Uint32Array.from(targets, () => random(3)), dict: ['a', 'b', 'c'] };
    const filterValues = Uint8Array.from(targets, () => random(3));
    const accepts = Uint8Array.of(1, 0, 1);
    const start = axis.range.frame.resolveValue(0);
    const axisCumulative = context.scopeBreakdown.population.cumulative;
    const total = axisCumulative.at(-1)! + axisValues.at(-1)!;
    const reads = new Set<number>();

    source.attributes = [attribute];
    viewport.filter.set({ key: 'source', domain: 'event', size: targets.length, values: filterValues, accepts });

    if (grouped) {
        source.signatures = new EventSignatures(source);
        axis.signatures = new EventSignatures(axis);
    }

    source.mappings.timeline._mapping = new Proxy(targets, { get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
            reads.add(Number(property));
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? value.bind(target) : value;
    } });

    for (const [from, to, n] of [[0, 1, 7], [0.3, 0.45, 13], [0.5, 0.52, 3], [0.97, 1, 5], [0, 1, 1], [0.2, 0.6, 1]]) {
        const scopeViewport = { start: start + total * from, end: start + total * to };
        const step = (scopeViewport.end - scopeViewport.start) / n;
        const expected = attribute.dict.map(() => new Array(n).fill(0));
        // Targets shifted by one: a target on the grid marks itself and both neighbors
        const nearTargets = new Uint8Array(axisValues.length + 2);
        const onGrid = (event: number) => {
            const position = start + axisCumulative[targets[event]] - scopeViewport.start;

            return position >= 0 && position < scopeViewport.end - scopeViewport.start ? position : -1;
        };

        for (let event = 0; event < targets.length; event++) {
            const position = onGrid(event);

            if (position !== -1) {
                nearTargets.fill(1, targets[event], targets[event] + 3);

                if (accepts[filterValues[event]] === 1) {
                    expected[attribute.values[event]][Math.floor(position / step)] += source.values[event];
                }
            }
        }

        reads.clear();
        const actual = methods.binLineToAxisLine.call({ context: { ...context, scopeViewport } }, source, attribute, axis, n);

        assert.deepEqual(actual.map(row => [...row.bins]), expected, `${from}-${to}/${n}`);

        // Visited events are the events with targets on the grid or one target off it; the other reads are the
        // edge events of the source range and two binary searches
        let near = 2;

        for (let event = 1; event < targets.length - 1; event++) {
            near += nearTargets[targets[event] + 1];
        }

        assert.ok(reads.size <= near + 2 * Math.ceil(Math.log2(targets.length + 1)), `${from}-${to}/${n}: ${reads.size} reads`);
    }
});

test('mapped records of whole targets equal event binning across source range cuts and filters', async () => {
    const random = sequence(3);
    const axisValues = Uint32Array.from({ length: 30 }, () => 1 + random(9));
    const context = await createContext({ values: axisValues, samples: Uint32Array.from(axisValues, () => random(3)) });
    const axis = context.scopeLine;
    const axisViewport = context.scopeBreakdown.populationWindow;
    const targets = Uint32Array.from({ length: 400 }, () => random(axisValues.length)).sort();
    const { source, viewport } = await createMappedSource(axis, Uint32Array.from(targets, () => random(6) === 0 ? 0 : 1 + random(20)), targets, Uint32Array.from(targets, () => random(4)));
    const attribute = { name: 'allocationType' as const, values: Uint32Array.from(targets, () => random(3)), dict: ['a', 'b', 'c'] };
    const start = axis.range.frame.resolveValue(0);
    const total = axisValues.reduce((sum, value) => sum + value, 0);
    const cumulative = viewport.population.cumulative;
    const sourceTotal = viewport.population.cumulativeEnd;
    const grids = [[0, 1, 9], [0.2, 0.7, 11], [0.4, 0.45, 2], [0, 1, 1]];
    const bins = () => grids.map(([from, to, n]) => methods.binLineToAxisLine.call(
        { context: { ...context, scopeViewport: { start: start + total * from, end: start + total * to } } }, source, attribute, axis, n
    ).map(row => [row.value, ...row.bins]));
    const signatures = () => {
        source.signatures = new EventSignatures(source);
        axis.signatures = new EventSignatures(axis);
    };
    const events = () => {
        source.signatures = null;
        axis.signatures = null;
    };

    source.attributes = [attribute];
    viewport.filter.set({ key: 'source', domain: 'event', size: targets.length, values: attribute.values, accepts: Uint8Array.of(1, 1, 0) });

    for (const ranges of [
        null,
        // Cuts inside events of one target, at event edges, and gaps over whole targets
        [{ start: cumulative[37] + 0.5, end: cumulative[90] }, { start: cumulative[90] + 1, end: cumulative[211] + 0.25 }, { start: cumulative[300], end: sourceTotal }],
        [{ start: cumulative[5] + 1, end: cumulative[6] }]
    ]) {
        viewport.setRanges(ranges);
        events();
        const expected = bins();

        signatures();
        assert.deepEqual(bins(), expected, JSON.stringify(ranges));
        // Complete records of the grids are reused
        assert.deepEqual(bins(), expected, `${JSON.stringify(ranges)} with complete records`);

        axisViewport.filter.set({ key: 'axis', domain: 'sample', size: 3, accepts: Uint8Array.of(1, 0, 1) });
        const axisFiltered = bins();

        events();
        assert.deepEqual(axisFiltered, bins(), `${JSON.stringify(ranges)} with an axis filter`);
        axisViewport.filter.remove('axis');
    }
});

//
// Allocation attribute rows: allocationAttributeRows, binAllocationAttribute, viewportAllocationAttribute
//

test('allocation attribute rows take dictionary order, entry colors and whole-line totals', async () => {
    const { profile, line, breakdown } = await createLineFixture({ type: 'memline', values: new Uint32Array([16, 32, 48, 64]) });
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown };
    const spaces = [{ code: 'new', name: 'new_space', color: '#101010' }, { code: 'old', name: 'old_space', color: '#202020' }];
    const owner = { scriptId: 1, start: 0 };
    const rows = () => line.attributes.map(attribute => methods.allocationAttributeRows.call({ context }, attribute.name));
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
        { name: 'allocationType', values: Uint32Array.of(0, 1, 1, 0), dict: ['array', 'string'] },
        { name: 'allocationSpace', values: Uint32Array.of(1, 1, 0, 1), dict: spaces },
        { name: 'allocationOwner', values: Uint32Array.of(0, 1, 1, 1), dict: [null, owner] }
    ];
    assert.deepEqual(rows(), expected);

    // Rows don't follow the viewport or filters
    breakdown.populationViewport.setRanges([{ start: 0, end: 20 }]);
    breakdown.populationWindow.setRanges([{ start: 0, end: 20 }]);
    breakdown.populationWindow.filter.set({ key: 'test', domain: 'event', size: 4, accepts: Uint8Array.of(0, 0, 0, 0) });
    assert.deepEqual(rows(), expected);

    // Per-signature totals of the line give the same totals
    line.signatures = new EventSignatures(line);
    assert.deepEqual(rows(), expected);
});

test.each([
    'binAllocationAttribute',
    'allocationAttributeRows',
    'viewportAllocationAttribute'
] as const)('%s gives no rows without a memline or for an unknown attribute', async method => {
    const timeline = await createContext();
    const memline = await createContext({ type: 'memline' });

    memline.scopeLine.attributes = [{ name: 'allocationType', values: new Uint32Array(3), dict: ['array'] }];
    assert.deepEqual(methods[method].call({ context: timeline }, 'allocationType'), []);
    assert.deepEqual(methods[method].call({ context: memline }, 'allocationSpace'), []);
});

//
// Timestamp streams: heap events and function codes
//

test.each([
    {
        name: 'the viewport grid with missing coverage around the line',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10, initial: 100,
        events: heapEvents([[130, 'new', 10], [140, 'delete', 10]]),
        added: [0, 0, 10, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 100, 0, 0, 0, 0, 0]
    },
    {
        name: 'the line viewport with boundary and final events',
        options: {}, scopeViewport: null, count: 5, initial: 100,
        events: heapEvents([[130, 'new', 10], [140, 'delete', 10], [150, 'new', 20]]),
        added: [10, 0, 0, 0, 20],
        total: [110, 110, 110, 100, 120]
    },
    {
        name: 'final events of an offset population',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10, initial: 100,
        events: heapEvents([[130, 'new', 10], [150, 'new', 10], [225, 'new', 10]]),
        added: [0, 0, 10, 0, 10, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 120, 120, 120, 120, 120, 120]
    },
    {
        name: 'no events',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10, initial: 100,
        events: heapEvents([]),
        added: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 100, 100, 100, 0, 0, 0, 0, 0]
    },
    {
        name: 'a viewport after an earlier peak',
        options: { origin: 0, values: new Uint32Array([1000]) }, scopeViewport: { start: 400, end: 500 }, count: 4, initial: 0,
        events: heapEvents([[10, 'new', 1000], [300, 'delete', 900], [425, 'new', 20], [450, 'delete', 10]]),
        added: [20, 0, 0, 0],
        total: [120, 120, 110, 110]
    },
    {
        name: 'events at the viewport start',
        options: {}, scopeViewport: { start: 130, end: 140 }, count: 2, initial: 100,
        events: heapEvents([[120, 'new', 50], [130, 'delete', 30], [130, 'new', 10]]),
        added: [10, 0],
        total: [150, 130]
    },
    {
        name: 'an event at the viewport end, whose bin end is rounded below it',
        options: { origin: 0, values: new Uint32Array([100]) }, scopeViewport: { start: 10, end: 15 }, count: 3, initial: 0,
        events: heapEvents([[15, 'new', 7]]),
        added: [0, 0, 7],
        total: [0, 0, 7]
    },
    {
        name: 'a leading event without a timestamp',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10, initial: 100,
        events: heapEvents([[0, 'new', 50], [130, 'new', 10]]),
        added: [0, 0, 10, 0, 0, 0, 0, 0, 0, 0],
        total: [0, 0, 110, 110, 110, 0, 0, 0, 0, 0]
    },
    {
        name: 'events after samples',
        options: { origin: 0, after: 75 }, scopeViewport: { start: 0, end: 100 }, count: 4, initial: 100,
        events: heapEvents([[75, 'new', 20]]),
        added: [0, 0, 20, 0],
        total: [100, 100, 120, 120]
    },
    {
        name: 'an event after the end of the line',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10, initial: 100,
        events: heapEvents([[130, 'new', 10], [170, 'new', 20]]),
        added: [0, 0, 10, 0, 0, 0, 20, 0, 0, 0],
        total: [0, 0, 110, 110, 110, 110, 130, 0, 0, 0]
    },
    {
        name: 'a viewport after the line',
        options: {}, scopeViewport: { start: 300, end: 400 }, count: 4, initial: 100,
        events: heapEvents([[130, 'new', 10]]),
        added: [0, 0, 0, 0],
        total: [0, 0, 0, 0]
    }
])('heap events and heap total on $name', async ({ options, scopeViewport, count, initial, events, added, total }) => {
    const context = await createContext(options, scopeViewport);

    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', count)), added);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, count, initial)), total);
});

test('heap total accepts a null resolved viewport when the line is explicit', async () => {
    const { scopeLine } = await createContext();

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context: {} }, heapEvents([[130, 'new', 10]]), 5, 100, scopeLine)), [110, 110, 110, 110, 110]);
});

test.each([
    {
        name: 'the viewport grid with missing coverage around the line',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10,
        codes: functionCodes([[5, 'Ignition', 0]]),
        compilations: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        functions: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        tiers: { Ignition: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0] }
    },
    {
        name: 'a tier change at the end of the line',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0]]),
        compilations: [0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
        functions: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
        tiers: { Ignition: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0], Sparkplug: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0] }
    },
    {
        name: 'the line viewport with tier changes at bin boundaries',
        options: {}, scopeViewport: null, count: 5,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0]]),
        compilations: [1, 0, 0, 0, 1],
        functions: [1, 1, 1, 1, 1],
        tiers: { Ignition: [1, 1, 1, 1, 0], Sparkplug: [0, 0, 0, 0, 1] }
    },
    {
        name: 'final events of an offset population',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10,
        codes: functionCodes([[5, 'Ignition', 0], [25, 'Sparkplug', 0], [100, 'Ignition', 0]]),
        compilations: [0, 0, 1, 0, 1, 1, 1, 1, 1, 1],
        functions: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
        tiers: { Ignition: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0], Sparkplug: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1] }
    },
    {
        name: 'no codes',
        options: {}, scopeViewport: { start: 100, end: 200 }, count: 10,
        codes: functionCodes([]),
        compilations: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        functions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tiers: {}
    },
    {
        name: 'a viewport after the history of a function',
        options: { origin: 100, values: new Uint32Array([1000]) }, scopeViewport: { start: 500, end: 600 }, count: 4,
        codes: functionCodes([[10, 'Ignition', 0], [300, 'Sparkplug', 0], [425, 'Ignition', 1]]),
        compilations: [1, 1, 1, 1],
        functions: [2, 2, 2, 2],
        tiers: { Ignition: [1, 1, 1, 1], Sparkplug: [1, 1, 1, 1] }
    },
    {
        name: 'a viewport after all codes',
        options: { origin: 100, values: new Uint32Array([1000]) }, scopeViewport: { start: 500, end: 600 }, count: 4,
        codes: functionCodes([[10, 'Ignition', 0], [300, 'Sparkplug', 0]]),
        compilations: [0, 0, 0, 0],
        functions: [1, 1, 1, 1],
        tiers: { Sparkplug: [1, 1, 1, 1] }
    },
    {
        name: 'a code at the viewport start',
        options: {}, scopeViewport: { start: 130, end: 140 }, count: 2,
        codes: functionCodes([[5, 'Ignition', 0]]),
        compilations: [1, 1],
        functions: [1, 1],
        tiers: { Ignition: [1, 1] }
    },
    {
        name: 'a code at the viewport end, whose bin end is rounded below it',
        options: { origin: 0, values: new Uint32Array([100]) }, scopeViewport: { start: 10, end: 15 }, count: 3,
        codes: functionCodes([[15, 'Ignition', 0]]),
        compilations: [0, 0, 1],
        functions: [0, 0, 1],
        tiers: { Ignition: [0, 0, 1] }
    },
    {
        name: 'codes after samples',
        options: { origin: 0, after: 75 }, scopeViewport: { start: 0, end: 100 }, count: 4,
        codes: functionCodes([[75, 'Ignition', 0]]),
        compilations: [0, 0, 1, 1],
        functions: [0, 0, 1, 1],
        tiers: { Ignition: [0, 0, 1, 1] }
    }
])('function compilations and states on $name', async ({ options, scopeViewport, count, codes, compilations, functions, tiers }) => {
    const context = await createContext(options, scopeViewport);
    const states = methods.binScriptFunctionCodesTotal.call({ context }, codes, count);
    // Tiers without functions are omitted
    const actualTiers: Record<string, number[]> = {};

    for (const [tier, bins] of states.byTier) {
        if (bins.some(functionCount => functionCount > 0)) {
            actualTiers[tier] = Array.from(bins);
        }
    }

    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, count)), compilations);
    assert.deepEqual(Array.from(states.fnCount), functions);
    assert.deepEqual(actualTiers, tiers);
});

//
// Costs
//

test('reads viewport properties outside allocation and counter event loops', async () => {
    const context = await createContext();
    const { source, viewport: sourceViewport } = await createMappedSource(context.scopeLine,
        new Uint32Array(3000).fill(1), Uint32Array.from({ length: 3000 }, (_, index) => Math.floor(index / 1000)), new Uint32Array(3000));
    const reads: Map<string, number> = new Map();

    for (const [label, viewport] of [['source', sourceViewport], ['axis', context.scopeBreakdown.populationWindow]] as const) {
        for (const key of ['samples', 'values', 'sinkId', 'cumulative', 'ranges'] as const) {
            const value = viewport[key];
            const name = `${label}.${key}`;

            Object.defineProperty(viewport, key, { get() {
                reads.set(name, (reads.get(name) ?? 0) + 1);

                return value;
            } });
        }
    }

    for (const compute of [
        () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10),
        () => methods.binLineToAxisLine.call({ context: {
            scopeLine: source, scopeBreakdown: source.breakdowns[0], scopeViewport: { start: 0, end: 3000 }
        } }, source, null, source, 10),
        () => methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10),
        () => methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10),
        () => samplesMethods.countSamples.call({ context }, 10)
    ]) {
        reads.clear();
        compute();

        for (const [name, count] of reads) {
            assert.ok(count <= 2, `${name}: ${count} property reads`);
        }
    }
});

// Bin records are kept until the window changes (population.md), so aggregations over a recorded grid with other
// groups and filter selections read the events crossing bin edges, two edge events and the events of two binary
// searches of the mapping, rather than every event
test.each([1, 10])('aggregations over a recorded grid read events only at its edges (%i bins)', async count => {
    const length = 3000;
    const context = await createContext({ origin: 0, values: new Uint32Array(30).fill(10), samples: new Uint32Array(30) }, { start: 0, end: 300 });
    const axis = context.scopeLine;
    const { source, viewport } = await createMappedSource(axis,
        Uint32Array.from({ length }, (_, event) => 1 + event % 5),
        Uint32Array.from({ length }, (_, event) => Math.floor(event / 100)),
        Uint32Array.from({ length }, (_, event) => event % 4));
    const [breakdown] = source.breakdowns;
    const types = Uint32Array.from({ length }, (_, event) => event % 3);
    const attribute = { name: 'allocationType' as const, values: types, dict: ['a', 'b', 'c'] };
    const ownContext = { scopeLine: source, scopeBreakdown: breakdown, scopeViewport: { start: 0, end: viewport.cumulativeEnd } };
    const aggregations = [
        (grouping: typeof attribute | null) => methods.binLineToAxisLine.call({ context: ownContext }, source, grouping, source, count),
        (grouping: typeof attribute | null) => methods.binLineToAxisLine.call({ context }, source, grouping, axis, count)
    ];
    const selectTypes = (accepts: Uint8Array) => {
        for (const population of [breakdown.populationViewport, breakdown.populationWindow]) {
            population.filter.set({ key: 'type', domain: 'event', size: length, values: types, accepts });
        }
    };
    let reads = 0;
    const counted = (vector: Uint32Array) => new Proxy(vector, { get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
            reads++;
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? value.bind(target) : value;
    } });

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
    const context = await createContext({ origin: 0, samples: new Uint32Array(length), values: new Uint32Array(length).fill(10) }, { start: 0, end: length * 10 });
    const { population: base, populationWindow: viewport } = context.scopeBreakdown;
    let reads = 0;

    viewport.setRanges([{ start: 100, end: 200 }, { start: 900_000, end: 900_100 }]);
    base.values = new Proxy(base.values, { get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
            const index = Number(property);

            reads++;
            assert.ok(index >= 10 && index < 20 || index >= 90_000 && index < 90_010, `Read gap event ${index}`);
        }

        return Reflect.get(target, property, target);
    } });
    context.scopeLine.values = base.values;

    for (const compute of [
        () => methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 500),
        () => methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 500),
        () => samplesMethods.countSamples.call({ context }, 500),
        () => samplesMethods.countSamplesDiscrete.call({ context }, 500, undefined)
    ]) {
        reads = 0;
        compute();
        assert.ok(reads <= 24, `${reads} weight reads for 20 visible events`);
    }
});

test.skipIf(!process.env.CPUPRO_BIN_BENCH)('measures viewport binning on seven million allocations', async () => {
    const length = 7_000_000;
    const context = await createContext({ origin: 0, samples: new Uint32Array(70_000), values: new Uint32Array(70_000).fill(100) }, { start: 0, end: length });
    const axis = context.scopeLine;
    const { source, viewport } = await createMappedSource(axis, new Uint32Array(length).fill(1),
        Uint32Array.from({ length }, (_, index) => Math.floor(index / 100)), Uint32Array.from({ length }, (_, index) => index % 16));
    const base = viewport.population;
    const ownContext = { scopeLine: source, scopeBreakdown: source.breakdowns[0], scopeViewport: context.scopeViewport };
    const attribute = { name: 'allocationType', values: base.samples, dict: Array.from({ length: 16 }, (_, index) => String(index)) } as const;
    const mask = new Uint8Array(16).fill(1);
    const categories = source.breakdowns[0].categories!.all.nodes;
    const results: { name: string; constrained: boolean; medianMs: number }[] = [];

    for (const constrained of [false, true]) {
        if (constrained) {
            viewport.updateMask(bits => {
                bits[0] = 1;
            });
            viewport.setRanges(Array.from({ length: 32 }, (_, index) => ({ start: index * 200_000 + 1000, end: index * 200_000 + 2000 })));
        }

        assert.deepEqual(
            Array.from(viewport.aggregateBy(attribute.values, attribute.dict.length).samplesTotal),
            methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, undefined, 1).map(row => row.value)
        );

        for (const [name, compute] of [
            ['mapped', () => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 500)],
            ['own', () => methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, undefined, 500)],
            ['own-summary', () => methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, undefined, 1)],
            ['totals', () => viewport.aggregateBy(attribute.values, attribute.dict.length)],
            ['categories', () => methods.binTreeSamples.call({ context: ownContext }, categories, 500)],
            ['categories-legacy', () => categories.tree.dictionary.map(entry => ({
                self: methods.binCalls.call({ context: ownContext }, categories, entry, 500),
                nested: methods.binCallsFromMask.call({ context: ownContext }, treeMethods.subtreeSamples(categories, entry).mask, 500)
            }))],
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
