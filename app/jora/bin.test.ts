import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from './bin.js';
import { methods as profileMethods } from './profile.js';
import { RangeSelection } from '../prepare/computations/range.js';
import { methods as samplesMethods } from './samples.js';
import type { ProfileLine } from '../prepare/lines/types.js';
import { createState, selectRange } from '../views/ruler-range.js';

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

test('binCount uses the resolved viewport only when its argument is omitted', () => {
    const context = createContext();
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
        data: { profiles: [{ timeline: { axisStart: 100, axisEnd: 300 } }] }
    }), 200);
    const count = query('10.binCount()')({}, context);
    assert.deepEqual(query('10.binCount().countSamples()')({}, context), samplesMethods.countSamples.call({ context }, count));
    assert.deepEqual(context.scopeViewport, { start: 100, end: 200 });
    assert.equal(context.scopeLine.range.selection.ranges, parentSelection);
});

function createContext() {
    const profile = { runtime: {}, lines: [] as ProfileLine[] };
    const line = {
        profile, type: 'timeline', kind: 'time', axisTotal: 25,
        axisStart: 125, axisEnd: 150,
        values: new Uint32Array([10, 10, 5]),
        range: new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: 25 }, 125),
        mappings: {}, breakdowns: []
    } as unknown as ProfileLine;
    profile.lines.push(line);
    Object.assign(profile, { timeline: line });
    const population = {
        samples: new Uint32Array([0, 1, 0]), values: line.values,
        cumulative: new Uint32Array([0, 10, 20])
    };
    const breakdown = { kind: 'call-stack', line, population };
    line.breakdowns.push(breakdown as ProfileLine['breakdowns'][number]);

    return {
        scopeViewport: { start: 100, end: 200 },
        scopeLine: line, scopeProfile: profile, scopeBreakdown: breakdown
    };
}

test('bins a short population on the viewport grid instead of stretching its local bins', () => {
    const line = {
        axisTotal: 25,
        range: new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: 25 }, 125)
    };
    const context = {
        scopeViewport: { start: 100, end: 200 },
        scopeBreakdown: {
            line,
            population: { samples: new Uint32Array([0, 1, 0]), values: new Uint32Array([10, 10, 5]) }
        }
    };
    const mask = new Uint8Array([1, 0]);
    const bins = methods.binCallsFromMask.call({ context }, mask, 10);

    assert.deepEqual(Array.from(bins), [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);
    assert.equal(bins.reduce((total, value) => total + value, 0), 15);
});

test('binning uses the context default and switches to a nested viewport override', () => {
    const source = createContext();
    const context = {
        ...source, scopeViewport: undefined,
        data: { profiles: [{ timeline: { axisStart: 100, axisEnd: 200 } }] }
    };
    const mask = new Uint8Array([1, 0]);
    const bins = methods.binCallsFromMask.call({ context }, mask, 10);
    assert.deepEqual(bins, [0, 0, 5, 5, 5, 0, 0, 0, 0, 0]);

    const scopeViewport = { start: 125, end: 150 };
    const nested = { ...context, scopeViewport };
    assert.deepEqual(methods.binCallsFromMask.call({ context: nested }, mask, 10), [2.5, 2.5, 2.5, 2.5, 0, 0, 0, 0, 2.5, 2.5]);
    assert.equal(context.scopeViewport, undefined);
});

test('category bins and presence use the same grid and retain the total contribution', () => {
    const context = createContext();
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

test('sample counters follow viewport boundaries without counting the starting bin twice', () => {
    const context = createContext();
    assert.deepEqual(Array.from(samplesMethods.countSamples.call({ context }, 10)), [0, 0, 1, 2, 2, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(samplesMethods.countSamplesDiscrete.call({ context }, 10, undefined)), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
});

test('heap events and state start on the viewport grid and never extend into missing coverage', () => {
    const context = createContext();
    const events = [{ tm: 130, event: 'new', size: 10 }, { tm: 140, event: 'delete', size: 10 }] as Parameters<typeof methods.binHeapTotal>[0];
    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 10)), [0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 10, 100)), [0, 0, 110, 110, 100, 0, 0, 0, 0, 0]);
});

test('timestamp binning accepts a null resolved viewport when the line is explicit', () => {
    const line = createContext().scopeLine;
    const events = [{ tm: 130, event: 'new', size: 10, address: '0x1' }] as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context: {} }, events, 5, 100, line)), [110, 110, 110, 110, 110]);
});

test('code states and compilations leave viewport padding empty', () => {
    const context = createContext();
    const codes = [{ tm: 5, tier: 'Ignition', callFrameCodes: {} }] as Parameters<typeof methods.binScriptFunctionCodesTotal>[0];
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, codes, 10)), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, codes, 10);
    assert.deepEqual(Array.from(total.fnCount), [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(total.byTier.find(([tier]) => tier === 'Ignition')![1]), Array.from(total.fnCount));
    codes.push({ ...codes[0], tm: 25, tier: 'Sparkplug' });
    const boundary = methods.binScriptFunctionCodesTotal.call({ context }, codes, 10);
    assert.deepEqual(Array.from(boundary.fnCount), Array.from(total.fnCount));
});

test('retains the integer step optimization with an offset population', () => {
    const context = createContext();
    context.scopeViewport = { start: 100, end: 201 };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1, 1]), 10);

    assert.deepEqual(bins, [0, 0, 8, 11, 6, 0, 0, 0, 0, 0]);
    assert.equal(bins.reduce((total, value) => total + value, 0), 25);
});

test.each([
    [101, [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]],
    [25, [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]],
    [27, [2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7, 2.7]]
] as const)('preserves the rounding threshold and total contribution for total=%i', (total, expected) => {
    const context = {
        scopeBreakdown: {
            line: { axisTotal: total },
            population: { samples: new Uint32Array([0]), values: new Uint32Array([total]) }
        }
    };
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 10);

    for (let index = 0; index < bins.length; index++) {
        assert.ok(Math.abs(bins[index] - expected[index]) < 1e-10);
    }
    assert.ok(Math.abs(bins.reduce((sum, value) => sum + value, 0) - total) < 1e-10);
});

test('allocation mapping uses the axis viewport while retaining source totals', () => {
    const context = createContext();
    const source = {
        values: new Uint32Array([3, 4, 5]), axisTotal: 12,
        mappings: { timeline: { _mapping: new Uint32Array([0, 1, 2]) } }
    } as unknown as ProfileLine;
    const mapped = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 10)[0];
    assert.deepEqual(Array.from(mapped.bins), [0, 0, 3, 4, 5, 0, 0, 0, 0, 0]);
    assert.equal(mapped.total, 12);
    const own = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 10)[0];
    assert.deepEqual(Array.from(own.bins), [0, 0, 5, 10, 10, 0, 0, 0, 0, 0]);
    assert.equal(own.step, 10);
});

test('preserves heap boundary events and the final event without a viewport', () => {
    const context = { ...createContext(), scopeViewport: undefined };
    const events = [
        { tm: 130, event: 'new', size: 10 },
        { tm: 140, event: 'delete', size: 10 },
        { tm: 150, event: 'new', size: 20 }
    ] as Parameters<typeof methods.binHeapTotal>[0];

    assert.deepEqual(Array.from(methods.binHeapEvents.call({ context }, events, 'new', 5)), [10, 0, 0, 0, 20]);
    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, events, 5, 100)), [110, 110, 110, 100, 120]);
});

test('preserves compilation and tier transitions at bin boundaries without a viewport', () => {
    const context = { ...createContext(), scopeViewport: undefined };
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

test('retains final boundary events in an offset population without filling the following padding', () => {
    const context = createContext();
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

test('keeps initial heap state within coverage and empty code streams empty', () => {
    const context = createContext();
    const empty = new Array(10).fill(0);

    assert.deepEqual(Array.from(methods.binHeapTotal.call({ context }, [], 10, 100)), [0, 0, 100, 100, 100, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(methods.binScriptFunctionCodes.call({ context }, [], 10)), empty);
    const total = methods.binScriptFunctionCodesTotal.call({ context }, [], 10);
    assert.deepEqual(Array.from(total.fnCount), empty);
    for (const [, bins] of total.byTier) {
        assert.deepEqual(Array.from(bins), empty);
    }
});

test('binSignals keeps explicit total and skip independent of the active viewport', () => {
    const context = createContext();
    const treeMetrics = {
        tree: { dictionary: [{}], nodes: new Uint32Array([0]) },
        sampleToNode: new Uint32Array([0, 0])
    };
    const options = { n: 10, total: 101, skip: 25 };
    const expected = [0, 0, 8, 11, 6, 0, 0, 0, 0, 0];

    assert.deepEqual(Array.from(methods.binSignals.call({ context }, treeMetrics, options)), expected);
    assert.deepEqual(Array.from(methods.binSignals.call({ context: { ...context, scopeViewport: undefined } }, treeMetrics, options)), expected);
});

test('initializes heap at the viewport boundary without importing an earlier peak', () => {
    const context = createContext();
    context.scopeLine.axisStart = 0;
    context.scopeLine.axisEnd = 1000;
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

test('code history seeds the viewport, but does not count as visible compilations', () => {
    const context = createContext();
    context.scopeLine.axisStart = 100;
    context.scopeLine.axisEnd = 1100;
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

test('events after samples are not truncated to the sample extent', () => {
    const context = createContext();
    context.scopeLine.axisStart = 0;
    context.scopeLine.axisEnd = 100;
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
] as const)('clips sample intervals to viewport [%i, %i] without copying or changing source values', (start, end, expected) => {
    const context = createContext();
    context.scopeViewport = { start, end };
    const values = context.scopeLine.values.slice();
    const bins = methods.binCallsFromMask.call({ context }, new Uint8Array([1, 0]), 2);
    assert.deepEqual(bins, expected);
    assert.deepEqual(context.scopeLine.values, values);
});

test('clips an interval spanning the entire viewport and preserves the optimized final remainder', () => {
    const context = createContext();
    context.scopeViewport = { start: 400, end: 501 };
    context.scopeLine.axisTotal = 1000;
    context.scopeLine.range = new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: 1000 });
    context.scopeBreakdown.population.samples = new Uint32Array([0]);
    context.scopeBreakdown.population.values = new Uint32Array([1000]);

    assert.deepEqual(methods.binCallsFromMask.call({ context }, new Uint8Array([1]), 10), [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]);
});

test('does not fold allocation mappings outside a narrow viewport into its last bin', () => {
    const context = createContext();
    context.scopeViewport = { start: 130, end: 140 };
    const source = {
        values: new Uint32Array([3, 4, 5]), axisTotal: 12,
        mappings: { timeline: { _mapping: new Uint32Array([0, 1, 2]) } }
    } as unknown as ProfileLine;
    const mapped = methods.binLineToAxisLine.call({ context }, source, null, context.scopeLine, 2)[0];
    assert.deepEqual(Array.from(mapped.bins), [0, 4]);
    const own = methods.binLineToAxisLine.call({ context }, context.scopeLine, null, context.scopeLine, 2)[0];
    assert.deepEqual(Array.from(own.bins), [5, 5]);
});

test('counts only intersecting samples and visible sample starts in a narrow viewport', () => {
    const context = createContext();
    context.scopeViewport = { start: 130, end: 140 };
    assert.deepEqual(Array.from(samplesMethods.countSamples.call({ context }, 2)), [1, 1]);
    assert.deepEqual(Array.from(samplesMethods.countSamplesDiscrete.call({ context }, 2, undefined)), [0, 1]);
});

test.each([101, 1001, 4961966])('bounds ruler approximation without removing integer binning for total=%i', total => {
    const count = Math.min(500, total);
    const context = {
        scopeBreakdown: {
            line: { axisTotal: total },
            population: { samples: new Uint32Array([0]), values: new Uint32Array([total]) }
        }
    };
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

test('clipped sample bins match scalar intersections across masks, offsets and bin counts', () => {
    const values = new Uint32Array([0, 10, 270, 5, 400, 315]);
    const samples = new Uint32Array([0, 1, 0, 1, 1, 0]);
    for (const [start, end] of [[-50, 150], [110, 211], [250, 400], [900, 1050], [1200, 1301]]) {
        for (const count of [1, 3, 10]) {
            for (const mask of [new Uint8Array([1, 0]), new Uint8Array([1, 1])]) {
                const total = end - start;
                const rounded = Math.ceil(total / count);
                const step = rounded * count - total < rounded ? rounded : total / count;
                const context = {
                    scopeBreakdown: { line: { axisTotal: 1000 }, population: { samples, values } }
                };
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
