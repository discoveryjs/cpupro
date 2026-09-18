import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from './bin.js';
import { methods as profileMethods } from './profile.js';
import { methods as samplesMethods } from './samples.js';
import type { ProfileLine } from '../prepare/lines/types.js';
import { createState, selectRange } from '../views/ruler-range.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { createLineMapping } from '../prepare/computations/line-mapping.js';

const query = jora.setup({ methods: { ...methods, ...samplesMethods, ...profileMethods } });

test('binCount accepts ranges and lengths without requiring a scope', () => {
    for (const length of [0, 0.5, 1, 1.9, 25, 499.9, 500, 500.9, 1000, 2 ** 32]) {
        const expected = Math.max(1, Math.min(500, Math.floor(length)));
        assert.equal(query('500.binCount($)')(length), expected);
        assert.equal(query('500.binCount($)')({ start: -10, end: length - 10 }), expected);
    }
    assert.equal(query('1.binCount(1000)')(), 1);
    assert.equal(query('25.binCount(1000)')(), 25);
    assert.equal(query('500.binCount(axisTotal)')({ axisTotal: 12.7 }), 12);
});

test('binCount uses the resolved viewport only when its argument is omitted', async () => {
    const context = await createContext();
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([200]) });
    const parentSelection = context.scopeLine.range.selection.ranges;
    const nested = { ...context, scopeViewport: { start: 120, end: 125 } };
    assert.equal(query('500.binCount()')({}, context), 100);
    assert.equal(query('500.binCount(scopeViewport())')({}, context), 100);
    assert.equal(query('500.binCount(missing)')({}, context), 100);
    assert.equal(query('500.binCount()')({}, nested), 5);
    assert.equal(query('500.binCount(0)')({}, nested), 1);
    assert.equal(query('500.binCount({ start: 0, end: 30 })')({}, nested), 30);
    assert.equal(query('500.binCount()')({}, { ...context, scopeViewport: undefined }), 25);
    assert.equal(query('500.binCount()')({}, {
        ...context, scopeViewport: undefined,
        data: { profiles: [other.profile] }
    }), 200);
    const count = query('10.binCount()')({}, context);
    assert.deepEqual(query('10.binCount().countSamples()')({}, context), samplesMethods.countSamples.call({ context }, count));
    assert.deepEqual(context.scopeViewport, { start: 100, end: 200 });
    assert.equal(context.scopeLine.range.selection.ranges, parentSelection);
});

async function createContext(options: Parameters<typeof createLineFixture>[0] = {}) {
    const { profile, line, breakdown } = await createLineFixture({ origin: 125, ...options });
    return {
        scopeViewport: { start: 100, end: 200 },
        scopeLine: line, scopeProfile: profile, scopeBreakdown: breakdown
    };
}

async function createMappedSource(axis: ProfileLine, values = new Uint32Array([3, 4, 5]), mapping = new Uint32Array([0, 1, 2]), samples = Uint32Array.from(values, (_, index) => index)) {
    const { line: source, breakdown } = await createLineFixture({ type: 'memline', values, samples });
    const { left, right } = createLineMapping(source, Array.from(mapping), axis, Array.from({ length: axis.values.length }, (_, index) => index));
    source.mappings[axis.type] = left;
    axis.mappings[source.type] = right;
    return { source, viewport: breakdown.populationViewport };
}

test('bins a short population on the viewport grid instead of stretching its local bins', async () => {
    const context = await createContext();
    const mask = new Uint8Array([1, 0]);
    const bins = methods.binCallsFromMask.call({ context }, mask, 10);

    assert.deepEqual(Array.from(bins), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    assert.equal(bins.reduce((total, value) => total + value, 0), 15);
});

test('binning uses the context default and switches to a nested viewport override', async () => {
    const source = await createContext();
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const context = {
        ...source, scopeViewport: undefined,
        data: { profiles: [other.profile] }
    };
    const mask = new Uint8Array([1, 0]);
    const bins = methods.binCallsFromMask.call({ context }, mask, 10);
    assert.deepEqual(bins, [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);

    const scopeViewport = { start: 125, end: 150 };
    const nested = { ...context, scopeViewport };
    assert.deepEqual(methods.binCallsFromMask.call({ context: nested }, mask, 10), [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5]);
    assert.equal(context.scopeViewport, undefined);
});

test('category bins and presence use the same grid and retain the total contribution', async () => {
    const context = await createContext();
    const category = { name: 'script' };
    const treeMetrics = {
        tree: { dictionary: [category, { name: 'idle' }], nodes: new Uint32Array([0, 1]) },
        sampleToNode: new Uint32Array([0, 1])
    };
    const bins = methods.binCalls.call({ context }, treeMetrics, category, 10);
    assert.deepEqual(Array.from(bins), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    const local = methods.binCalls.call({ context: { ...context, scopeViewport: undefined } }, treeMetrics, category, 10);
    assert.deepEqual(Array.from(local), [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5]);
});

test('sample counters follow viewport boundaries without counting the starting bin twice', async () => {
    const context = await createContext();
    assert.deepEqual(Array.from(samplesMethods.countSamples.call({ context }, 10)), [0, 0, 1, 2, 2, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(samplesMethods.countSamplesDiscrete.call({ context }, 10, undefined)), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
});

test('heap events and state start on the viewport grid and never extend into missing coverage', async () => {
    const context = await createContext();
    const events = [{ tm: 130, event: 'new', size: 10 }, { tm: 140, event: 'delete', size: 10 }] as Parameters<typeof methods.binHeapTotal>[0];
    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 10)), [0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 10, 100)), [0, 0, 110, 110, 100, 0, 0, 0, 0, 0]);
});

test('timestamp binning accepts a null resolved viewport when the line is explicit', async () => {
    const line = (await createContext()).scopeLine;
    const events = [{ tm: 130, event: 'new', size: 10, address: '0x1' }] as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context: {} }, events, 5, 100, line)), [110, 110, 110, 110, 110]);
});

test('code states and compilations leave viewport padding empty', async () => {
    const context = await createContext();
    const codes = [{ tm: 5, tier: 'Ignition', callFrameCodes: {} }] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, 10)), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, codes, 10);
    assert.deepEqual(Array.from(total.fnCount), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Ignition')![1]), Array.from(total.fnCount));
    codes.push({ ...codes[0], tm: 25, tier: 'Sparkplug' });
    const boundary = methods.binScriptFunctionCodesTotal.call({ context }, codes, 10);
    assert.deepEqual(Array.from(boundary.fnCount), Array.from(total.fnCount));
});

test('retains the integer step optimization with an offset population', async () => {
    const context = await createContext();
    context.scopeViewport = { start: 100, end: 201 };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10);

    assert.deepEqual(bins, [0, 0, 8, 11, 6, 0, 0, 0, 0, 0]);
    assert.equal(bins.reduce((total, value) => total + value, 0), 25);
});

test.each([
    [101, [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]],
    [25, [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]],
    [27, [2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7]]
] as const)('preserves the rounding threshold and total contribution for total=%i', async (total, expected) => {
    const { breakdown } = await createLineFixture({ values: new Uint32Array([total]) });
    const context = { scopeBreakdown: breakdown };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 10);

    for (let index = 0; index < bins.length; index++) {
        assert.ok(Math.abs(bins[index] - expected[index]) < 1e-10);
    }
    assert.ok(Math.abs(bins.reduce((sum, value) => sum + value, 0) - total) < 1e-10);
});

test('allocation mapping uses the axis viewport while retaining source totals', async () => {
    const context = await createContext();
    const { source } = await createMappedSource(context.scopeLine);
    const mapped = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];
    assert.deepEqual(Array.from(mapped.bins), [0, 0, 3, 4, 5, 0, 0, 0, 0, 0]);
    assert.equal(mapped.total, 12);
    const own = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10)[0];
    assert.deepEqual(Array.from(own.bins), [0, 0, 5, 10, 10, 0, 0, 0, 0, 0]);
    assert.equal(own.step, 10);
});

test('skips unmapped targets before reading weights in mapped accumulation', async () => {
    const context = await createContext();
    const mapping = new Uint32Array([0, 3, 0xffffffff, 1, 2]);
    const { source, viewport } = await createMappedSource(context.scopeLine, new Uint32Array([3, 4, 5, 6, 7]), new Uint32Array([0, 0, 0, 1, 2]));
    source.mappings.timeline._mapping = mapping;
    viewport.values = new Proxy(viewport.values, { get(target, property) {
        assert.notEqual(property, '1');
        assert.notEqual(property, '2');
        return Reflect.get(target, property, target);
    } });
    const bins = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];
    assert.deepEqual([...bins.bins], [0, 0, 3, 6, 7, 0, 0, 0, 0, 0]);
    assert.equal(bins.value, 16);
});

test('allocation bins apply source and axis viewport participation without affecting their Base coordinates', async () => {
    const context = await createContext();
    const { source, viewport } = await createMappedSource(context.scopeLine);
    viewport.setRange(1, 10);
    const mapped = () => methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];
    assert.deepEqual([...mapped().bins], [0, 0, 2, 4, 3, 0, 0, 0, 0, 0]);
    viewport.filter.set({ key: 'allocations', domain: 'event', size: 3, accepts: index => index !== 1 });
    assert.deepEqual([...mapped().bins], [0, 0, 2, 0, 3, 0, 0, 0, 0, 0]);
    context.scopeBreakdown.populationViewport.setRanges([{ start: 10, end: 25 }]);
    assert.deepEqual([...mapped().bins], [0, 0, 0, 0, 3, 0, 0, 0, 0, 0]);
    context.scopeBreakdown.populationViewport.filter.set({ key: 'axis', domain: 'sample', size: 2, accepts: sampleId => sampleId === 1 });
    assert.equal(mapped().value, 0);
    context.scopeBreakdown.populationViewport.filter.remove('axis');
    context.scopeBreakdown.populationViewport.setRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 21, end: 24 }]);
    const own = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10)[0];
    assert.deepEqual([...own.bins], [0, 0, 2, 0, 3, 0, 0, 0, 0, 0]);
    assert.deepEqual([...context.scopeLine.values], [10, 10, 5]);
});

test('preserves heap boundary events and the final event without a viewport', async () => {
    const context = { ...await createContext(), scopeViewport: undefined };
    const events = [
        { tm: 130, event: 'new', size: 10 },
        { tm: 140, event: 'delete', size: 10 },
        { tm: 150, event: 'new', size: 20 }
    ] as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 5)), [10, 0, 0, 0, 20]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 5, 100)), [110, 110, 110, 100, 120]);
});

test('preserves compilation and tier transitions at bin boundaries without a viewport', async () => {
    const context = { ...await createContext(), scopeViewport: undefined };
    const callFrameCodes = {};
    const codes = [
        { tm: 5, tier: 'Ignition', callFrameCodes },
        { tm: 25, tier: 'Sparkplug', callFrameCodes }
    ] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];

    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, 5)), [1, 0, 0, 0, 1]);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, codes, 5);
    assert.deepEqual(Array.from(total.fnCount), [1, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Ignition')![1]), [1, 1, 1, 1, 0]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Sparkplug')![1]), [0, 0, 0, 0, 1]);
});

test('retains final boundary events in an offset population without filling the following padding', async () => {
    const context = await createContext();
    const callFrameCodes = {};
    const codes = [
        { tm: 5, tier: 'Ignition', callFrameCodes },
        { tm: 25, tier: 'Sparkplug', callFrameCodes },
        { tm: 100, tier: 'Ignition', callFrameCodes }
    ] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];
    const events = codes.map(({ tm }) => ({ tm: tm + 125, event: 'new', size: 10 })) as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 10)), [0, 0, 10, 0, 10, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 10, 100)), [0, 0, 110, 110, 120, 120, 120, 120, 120, 120]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, 10)), [0, 0, 1, 0, 1, 1, 1, 1, 1, 1]);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, codes, 10);
    assert.deepEqual(Array.from(total.fnCount), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Sparkplug')![1]), [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test('keeps initial heap state within coverage and empty code streams empty', async () => {
    const context = await createContext();
    const empty = new Array(10).fill(0);

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, [], 10, 100)), [0, 0, 100, 100, 100, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, [], 10)), empty);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, [], 10);
    assert.deepEqual(Array.from(total.fnCount), empty);
    for (const [, bins] of total.byTier) {
        assert.deepEqual(Array.from(bins), empty);
    }
});

test('binSignals keeps explicit total and skip independent of the active viewport', async () => {
    const context = await createContext();
    const treeMetrics = {
        tree: { dictionary: [{}], nodes: new Uint32Array([0]) },
        sampleToNode: new Uint32Array([0, 0])
    };
    const options = { n: 10, total: 101, skip: 25 };
    const expected = [0, 0, 8, 11, 6, 0, 0, 0, 0, 0];

    assert.deepEqual(Array.from(methods.binSignals.call({ context }, treeMetrics, options)), expected);
    assert.deepEqual(Array.from(methods.binSignals.call({ context: { ...context, scopeViewport: undefined } }, treeMetrics, options)), expected);
});

test('initializes heap at the viewport boundary without importing an earlier peak', async () => {
    const context = await createContext({ origin: 0, values: new Uint32Array([1000]) });
    context.scopeViewport = { start: 400, end: 500 };
    const events = [
        { tm: 10, event: 'new', size: 1000 },
        { tm: 300, event: 'delete', size: 900 },
        { tm: 425, event: 'new', size: 20 },
        { tm: 450, event: 'delete', size: 10 }
    ] as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 4, 0)), [120, 120, 110, 110]);
    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 4)), [20, 0, 0, 0]);
});

test('code history seeds the viewport, but does not count as visible compilations', async () => {
    const context = await createContext({ origin: 100, values: new Uint32Array([1000]) });
    context.scopeViewport = { start: 500, end: 600 };
    const first = {};
    const codes = [
        { tm: 10, tier: 'Ignition', callFrameCodes: first },
        { tm: 300, tier: 'Sparkplug', callFrameCodes: first },
        { tm: 425, tier: 'Ignition', callFrameCodes: {} }
    ] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];

    const total = methods.binScriptFunctionCodesTotal.call({ context }, codes, 4);
    assert.deepEqual(Array.from(total.fnCount), [2, 2, 2, 2]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Sparkplug')![1]), [1, 1, 1, 1]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, 4)), [1, 1, 1, 1]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes.slice(0, 2), 4)), [0, 0, 0, 0]);
});

test('events after samples are not truncated to the sample extent', async () => {
    const context = await createContext({ origin: 0, after: 75 });
    context.scopeViewport = { start: 0, end: 100 };
    const events = [{ tm: 75, event: 'new', size: 20 }] as Parameters<typeof methods.binHeapTotal>[0];
    const codes = [{ tm: 75, tier: 'Ignition', callFrameCodes: {} }] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 4)), [0, 0, 20, 0]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 4, 100)), [100, 100, 120, 120]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodesTotal.call({ context }, codes, 4).fnCount), [0, 0, 1, 1]);
});

test.each([
    [130, 140, [5, 0]],
    [120, 130, [0, 5]],
    [145, 155, [5, 0]],
    [100, 110, [0, 0]],
    [160, 170, [0, 0]]
] as const)('clips sample intervals to viewport [%i, %i] without copying or changing source values', async (start, end, expected) => {
    const context = await createContext();
    context.scopeViewport = { start, end };
    const values = context.scopeLine.values.slice();
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 2);
    assert.deepEqual(bins, expected);
    assert.deepEqual(context.scopeLine.values, values);
});

test('clips an interval spanning the entire viewport and preserves the optimized final remainder', async () => {
    const context = await createContext({ origin: 0, values: new Uint32Array([1000]) });
    context.scopeViewport = { start: 400, end: 501 };

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 10), [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]);
});

test('does not fold allocation mappings outside a narrow viewport into its last bin', async () => {
    const context = await createContext();
    context.scopeViewport = { start: 130, end: 140 };
    const { source } = await createMappedSource(context.scopeLine);
    const mapped = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 2)[0];
    assert.deepEqual(Array.from(mapped.bins), [0, 4]);
    const own = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 2)[0];
    assert.deepEqual(Array.from(own.bins), [5, 5]);
});

test('counts only intersecting samples and visible sample starts in a narrow viewport', async () => {
    const context = await createContext();
    context.scopeViewport = { start: 130, end: 140 };
    assert.deepEqual(Array.from(samplesMethods.countSamples.call({ context }, 2)), [1, 1]);
    assert.deepEqual(Array.from(samplesMethods.countSamplesDiscrete.call({ context }, 2, undefined)), [0, 1]);
});

test('viewport bins and counters preserve coordinates, disjoint coverage and source filter acceptance', async () => {
    const context = await createContext();
    const viewport = context.scopeBreakdown.populationViewport;
    const mask = new Uint8Array([1, 1]);
    viewport.filter.set({ key: 'sample', domain: 'sample', size: 2, accepts: sampleId => sampleId === 0 });
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, 10)], [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    const selection = context.scopeBreakdown.populationFiltered;
    selection.setRange(20, 25);
    selection.filter.set({ key: 'selection', domain: 'sample', size: 2, accepts: () => false });
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    viewport.filter.remove('sample');
    viewport.setRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 8, end: 12 }, { start: 21, end: 24 }]);
    assert.deepEqual(methods.binCallsFromMask.call({ context }, mask, 10), [0, 0, 2, 4, 3, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamples.call({ context }, 10)], [0, 0, 1, 2, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual([...samplesMethods.countSamplesDiscrete.call({ context }, 10, undefined)], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    viewport.setRanges([]);
    assert.ok(methods.binCallsFromMask.call({ context }, mask, 10).every(value => value === 0));
    assert.ok(samplesMethods.countSamples.call({ context }, 10).every(value => value === 0));
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

test('clipped sample bins match scalar intersections across masks, offsets and bin counts', async () => {
    const values = new Uint32Array([0, 10, 270, 5, 400, 315]);
    const samples = new Uint32Array([0, 1, 0, 1, 1, 0]);
    const context = await createContext({ origin: 0, values, samples });
    for (const [start, end] of [[-50, 150], [110, 211], [250, 400], [900, 1050], [1200, 1301]]) {
        for (const count of [1, 3, 10]) {
            for (const mask of [new Uint8Array([1, 0]), new Uint8Array([1, 1])]) {
                const total = end - start;
                const rounded = Math.ceil(total / count);
                const step = rounded * count - total < rounded ? rounded : total / count;
                const treeMetrics = {
                    tree: { dictionary: [0, 1], nodes: new Uint32Array([0, 1]) },
                    sampleToNode: new Uint32Array([0, 1])
                };
                const actual = methods.binSignals.call({ context }, treeMetrics, {
                    n: count, total, skip: -start, test: (entry: number) => mask[entry] === 1
                });
                const expected = new Float64Array(count);
                for (let index = 0, offset = 0; index < values.length; index++) {
                    if (mask[samples[index]]) {
                        for (let binIndex = 0; binIndex < count; binIndex++) {
                            expected[binIndex] += Math.max(0,
                                Math.min(offset + values[index], end, start + (binIndex + 1) * step) -
                                Math.max(offset, start + binIndex * step));
                        }
                    }
                    offset += values[index];
                }
                for (let index = 0; index < count; index++) {
                    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-8);
                }
            }
        }
    }
});

test('reads viewport properties outside allocation and counter event loops', async () => {
    const context = await createContext();
    const { source, viewport: sourceViewport } = await createMappedSource(context.scopeLine,
        new Uint32Array(3000).fill(1), Uint32Array.from({ length: 3000 }, (_, index) => Math.floor(index / 1000)), new Uint32Array(3000));
    const reads = new Map<string, number>();
    for (const [label, viewport] of [['source', sourceViewport], ['axis', context.scopeBreakdown.populationViewport]] as const) {
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

test('matches scalar bins and counters across disjoint ranges without shifting filtered coordinates', async () => {
    const context = await createContext({ origin: 0, samples: new Uint32Array([0, 1, 0, 1, 1, 0, 0]), values: new Uint32Array([0, 10, 270, 5, 400, 315, 0]) });
    const { population: base, populationViewport: viewport } = context.scopeBreakdown;
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
                                contribution += Math.max(0, Math.min(eventEnd, range.end, binEnd) - Math.max(eventStart, range.start, binStart));
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

test('seeks sparse ranges without reading event weights in the gaps', async () => {
    const length = 100_000;
    const context = await createContext({ origin: 0, samples: new Uint32Array(length), values: new Uint32Array(length).fill(10) });
    const { population: base, populationViewport: viewport } = context.scopeBreakdown;
    viewport.setRanges([{ start: 100, end: 200 }, { start: 900_000, end: 900_100 }]);
    let reads = 0;
    base.values = new Proxy(base.values, { get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
            const index = Number(property);
            reads++;
            assert.ok(index >= 10 && index < 20 || index >= 90_000 && index < 90_010, `Read gap event ${index}`);
        }
        return Reflect.get(target, property, target);
    } });
    context.scopeLine.values = base.values;
    context.scopeViewport = { start: 0, end: length * 10 };
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
    const context = await createContext({ origin: 0, samples: new Uint32Array(70_000), values: new Uint32Array(70_000).fill(100) });
    const axis = context.scopeLine;
    context.scopeViewport = { start: 0, end: length };
    const { source, viewport } = await createMappedSource(axis, new Uint32Array(length).fill(1),
        Uint32Array.from({ length }, (_, index) => Math.floor(index / 100)), Uint32Array.from({ length }, (_, index) => index % 16));
    const base = viewport.population;
    const ownContext = { scopeLine: source, scopeBreakdown: source.breakdowns[0], scopeViewport: context.scopeViewport };
    const attribute = { name: 'allocationType', values: base.samples, dict: Array.from({ length: 16 }, (_, index) => String(index)) } as const;
    const mask = new Uint8Array(16).fill(1);
    const results: { name: string; constrained: boolean; medianMs: number }[] = [];
    for (const constrained of [false, true]) {
        if (constrained) {
            viewport.updateMask(bits => {
                bits[0] = 1;
            });
            viewport.setRanges(Array.from({ length: 32 }, (_, index) => ({ start: index * 200_000 + 1000, end: index * 200_000 + 2000 })));
        }
        for (const [name, compute] of [
            ['mapped', () => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 500)],
            ['own', () => methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, undefined, 500)],
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
