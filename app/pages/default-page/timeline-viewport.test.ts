import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import jora from 'jora';
import { methods as appMethods } from '../../jora/index.mjs';
import { chartUsedHeap } from './chart-used-heap.js';
import { userTimingsTimeline } from './user-timings-timeline.js';
import { createState, selectRange, rangeToSegments } from '../../views/ruler-range.js';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';
import { PopulationFiltered } from '../../prepare/computations/population.js';
import { histCodes } from './hist-codes.js';
import { histHeapTotal } from './hist-heap-total.js';
import { histAllocationTypes } from './hist-allocation-types.js';
import { histAllocationSpaces } from './hist-allocation-spaces.js';
import { histAllocationLifespan } from './hist-allocation-lifespan.js';
import { histAllocationGcs } from './hist-allocation-gcs.js';
import { histAllocationCodeType } from './hist-allocation-code-type.js';

const methods = {
    ...appMethods,
    callAction(name, ...args) {
        return this.context.actions?.[name]?.(...args);
    }
};

const detailRenders = [];
const timeline = runInNewContext(readFileSync(new URL('../default.js', import.meta.url), 'utf8') + '\ncategoriesTimeline;', {
    require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), chartUsedHeap, userTimingsTimeline }),
    discovery: {
        nav: { primary: { append() {} } },
        page: { define() {} },
        view: {
            getViewStackTrace: target => target?.views ?? null,
            render: (...args) => detailRenders.push(args)
        }
    }
});
const query = jora.setup({ methods: { ...methods, marker: () => ({ href: '#' }) } });

test('tooltip dispatch selects one section and uses its current local data and scope', () => {
    const renderDetails = timeline.content[0].details.content[1].content.at(-1);
    const calls = detailRenders;
    const renderer = { render: renderDetails };
    calls.length = 0;
    const heap = {
        config: histHeapTotal,
        data: { revision: 1 },
        context: { scopeProfile: 'heap-profile', scopeLine: 'heap-line', scopeBreakdown: 'heap-breakdown' }
    };
    const codes = { config: histCodes, data: { revision: 2 }, context: { scopeLine: 'code-line' } };
    const target = { views: [heap, { config: {}, data: null, context: {} }] };
    const detail = { start: 20, end: 30 };
    const context = {
        detailTarget: target,
        detail,
        ruler: { selection: null },
        binStart: 2,
        binEnd: 3,
        scopeProfile: 'parent-profile',
        scopeLine: 'parent-line',
        scopeBreakdown: 'parent-breakdown'
    };

    renderDetails.call(renderer, null, {}, {}, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], histHeapTotal.rulerDetails);
    assert.equal(calls[0][2], heap.data);
    assert.equal(calls[0][3].detail, detail);
    assert.equal(calls[0][3].scopeProfile, 'heap-profile');
    assert.equal(calls[0][3].scopeLine, 'heap-line');
    assert.equal(calls[0][3].scopeBreakdown, 'heap-breakdown');

    target.views = [heap, codes];
    renderDetails.call(renderer, null, {}, {}, context);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], histCodes.rulerDetails);
    assert.equal(calls[1][2], codes.data);
    assert.equal(calls[1][3].scopeLine, 'code-line');

    codes.data = { revision: 3 };
    codes.context = { scopeLine: 'changed-breakdown' };
    renderDetails.call(renderer, null, {}, {}, context);
    assert.equal(calls[2][2], codes.data);
    assert.equal(calls[2][3].scopeLine, 'changed-breakdown');

    target.views = [];
    renderDetails.call(renderer, null, {}, {}, context);
    renderDetails.call(renderer, null, {}, {}, { ...context, detailTarget: null });
    assert.equal(calls.length, 3);
});

test.each([
    [histAllocationTypes, 'allocationType', '$.[value].sort(value desc)', 'cpupro-default-allocation-types'],
    [histAllocationSpaces, 'allocationSpace', '$.[value].sort(name.order() asc)', 'cpupro-default-allocation-spaces'],
    [histAllocationLifespan, 'allocationLifespan', '$.[value].sort(name.order() asc)', 'cpupro-default-allocation-lifespans'],
    [histAllocationGcs, 'allocationGcEpoch', '$.sort(name.order() asc)', 'cpupro-default-allocation-gcs'],
    [histAllocationCodeType, 'allocationCodeType', '$.[value].sort(name.order() asc)', 'cpupro-default-allocation-code-types']
] as const)('allocation section %# owns only its attribute query', async (section, name, order, stateKey) => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    const values = new Uint32Array([0, 1, 0, 1]);
    source.attributes = [
        { name: 'allocationType', values, dict: ['small', 'large', 'unused'] },
        { name: 'allocationSpace', values, dict: [{ code: 'new', name: 'New', color: 'red' }, { code: 'old', name: 'Old', color: 'blue' }] },
        { name: 'allocationLifespan', values: new Uint8Array(values), dict: ['alive', 'short-lived'] },
        { name: 'allocationGcEpoch', values, dict: [{ type: 'none', epoch: 0, color: 'red' }, { type: 'minor', epoch: 1, color: 'blue' }] },
        { name: 'allocationCodeType', values: new Uint8Array(values), dict: ['Ignition', 'Sparkplug'] }
    ];
    const attribute = source.attributes.find(attribute => attribute.name === name)!;
    const calls = [];
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binAllocationAttribute(...args) {
                calls.push(args[0]);
                return methods.binAllocationAttribute.apply(this, args);
            }
        }
    });
    const orderRows = query(order);

    for (const line of profile.lines) {
        for (const breakdown of line.breakdowns) {
            let expanded = false;
            const context = {
                scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown, binCount: 7, attribute,
                actions: {
                    getSessionSetting(key, fallback) {
                        assert.equal(key, stateKey);
                        assert.equal(fallback, false);
                        return expanded;
                    }
                }
            };
            for (const ranges of [null, [], [{ start: 5, end: 15 }, { start: 25, end: 35 }]]) {
                breakdown.populationViewport.filter.set({
                    key: 'test',
                    domain: 'event',
                    size: line.values.length,
                    accepts: index => ranges === null || index % 2 === 0
                });
                breakdown.populationViewport.setRanges(ranges);
                calls.length = 0;
                expanded = false;
                const panel = tracked(timeline.data)(profile, context);

                assert.deepEqual(calls, []);

                const data = tracked(section.data)(panel, context);
                const contentData = 'data' in section.content ? section.content.data : null;
                const expected = methods.binLineToAxisLine.call({ context }, source, attribute, line, context.binCount);

                assert.deepEqual(calls, [name]);

                const actual = contentData && data.length ? tracked(contentData)(data, context) : data;
                assert.deepEqual(actual, orderRows(expected));
                assert.ok(data.every(row => row.bins.length === 1));

                calls.length = 0;
                expanded = true;
                const open = tracked(section.data)(panel, context);
                const content = open.length ? tracked(contentData)(open, context) : open;

                assert.deepEqual(calls, [name]);
                assert.equal(content, open);
                assert.deepEqual(open, actual);
            }
        }
    }

    source.attributes = [];
    calls.length = 0;
    const context = { scopeProfile: profile, scopeLine: source, binCount: 7 };
    assert.deepEqual(tracked(section.data)({}, context), []);
    const { profile: cpuProfile } = await createProfileFixture({ cpuOnly: true });
    assert.deepEqual(tracked(section.data)({}, { scopeProfile: cpuProfile }), []);
    assert.deepEqual(calls, [name, name]);
});

test('GC uses a static state query and expands before the persisted state is updated', async () => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    source.attributes = [{
        name: 'allocationGcEpoch',
        values: new Uint32Array([0, 1, 1, 0]),
        dict: [{ type: 'none', epoch: 0, color: 'red' }, { type: 'minor', epoch: 1, color: 'blue' }]
    }];
    const calls = [];
    let expanded = false;
    const tracked = jora.setup({
        methods: {
            ...methods,
            binAllocationAttribute(...args) {
                calls.push(args[1]);
                return appMethods.binAllocationAttribute.apply(this, args);
            }
        }
    });
    const context = {
        scopeProfile: profile, scopeLine: source, scopeBreakdown: source.breakdowns[0], binCount: 7,
        actions: {
            getSessionSetting(name, fallback) {
                assert.equal(name, 'cpupro-default-allocation-gcs');
                assert.equal(fallback, false);
                return expanded;
            }
        }
    };
    const summary = tracked(histAllocationGcs.data)({}, context);

    assert.deepEqual(calls, [1]);
    const graph = tracked(histAllocationGcs.content.data)(summary, context);
    assert.deepEqual(calls, [1, 7]);
    assert.deepEqual(graph.map(row => row.value), summary.map(row => row.value));

    expanded = true;
    calls.length = 0;
    const open = tracked(histAllocationGcs.data)({}, context);
    assert.equal(tracked(histAllocationGcs.content.data)(open, context), open);
    assert.deepEqual(calls, [7]);
});

test('lifespan details use the scope interval instead of display bins', async () => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    source.attributes = [{
        name: 'allocationLifespan',
        values: new Uint8Array([0, 1, 1, 2]),
        dict: ['alive', 'short-lived', 'long-lived']
    }];
    const calls = [];
    const tracked = jora.setup({
        methods: {
            ...methods,
            binAllocationAttribute(...args) {
                calls.push(args[1]);
                return methods.binAllocationAttribute.apply(this, args);
            }
        }
    });
    const context = { scopeProfile: profile, scopeLine: source, scopeBreakdown: source.breakdowns[0], binCount: 7 };
    const selection = source.range.selection.ranges;
    const details = histAllocationLifespan.rulerDetails;
    const detailContext = tracked(details.context)(null, { ...context, detail: { start: 8, end: 64 } });
    const rows = tracked(details.data)(null, detailContext);

    assert.deepEqual(calls, [1]);
    assert.deepEqual(rows.map(row => [row.entry, row.value, row.total]), [['alive', 8, 56], ['short-lived', 48, 56]]);
    assert.deepEqual(tracked(details.data)([], { ...detailContext, binCount: 50 }), rows);
    assert.ok(rows.every(row => !('bins' in row)));

    source.breakdowns[0].populationViewport.setRanges([{ start: 1, end: 4 }, { start: 8, end: 12 }, { start: 20, end: 25 }]);
    const clipped = tracked(details.data)([], detailContext);
    assert.deepEqual(clipped.map(row => [row.entry, row.value, row.total]), [['alive', 4, 9], ['short-lived', 5, 9]]);
    assert.equal(source.range.selection.ranges, selection);
    assert.equal('scopeViewport' in context, false);

    source.breakdowns[0].populationViewport.setRanges([]);
    assert.deepEqual(tracked(details.data)(null, detailContext), []);

    source.breakdowns[0].populationViewport.setRanges(null);
    const axis = profile.timeline!;
    const target = source.mappings.timeline._mapping[1];
    const timestamp = axis.range.frame.resolveValue(axis.breakdowns[0].population.cumulative[target]);
    const projectedContext = tracked(details.context)(null, {
        ...context,
        scopeLine: axis,
        scopeBreakdown: axis.breakdowns[0],
        detail: { start: timestamp, end: timestamp + 1 }
    });
    const expected = [0, 0, 0];
    for (let index = 0; index < source.values.length; index++) {
        if (source.mappings.timeline._mapping[index] === target) {
            expected[source.attributes[0].values[index]] += source.values[index];
        }
    }
    const projected = tracked(details.data)([], projectedContext);

    assert.deepEqual(projected.map(row => row.value), expected.filter(value => value > 0));
    assert.ok(projected.every(row => row.total === expected.reduce((sum, value) => sum + value, 0)));

    axis.breakdowns[0].populationViewport.filter.set({
        key: 'test', domain: 'event', size: axis.values.length, accepts: index => index !== target
    });
    assert.deepEqual(tracked(details.data)([], projectedContext), []);
    assert.equal(source.range.selection.ranges, selection);
});

test('allocation headers cannot substitute source totals for selected-axis participation', async () => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    const axis = profile.timeline!;
    const context = { scopeProfile: profile, scopeLine: axis, scopeBreakdown: axis.breakdowns[0] };
    const attribute = { name: 'allocationType' as const, values: new Uint32Array([0, 1, 0, 1]), dict: ['first', 'second'] };
    const sourceTotals = () => methods.attributeSampleTotals(attribute, source.breakdowns[0].populationViewport);
    const axisTotals = () => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 1);

    assert.ok(axisTotals().some(row => row.value > 0));
    assert.equal(sourceTotals().reduce((total, row) => total + row.size, 0), 160);

    context.scopeBreakdown.populationViewport.setRanges([]);

    assert.ok(axisTotals().every(row => row.value === 0));
    assert.equal(sourceTotals().reduce((total, row) => total + row.size, 0), 160);

    const ownContext = { ...context, scopeLine: source, scopeBreakdown: source.breakdowns[0] };
    const graph = methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, source, 7);
    const singleBin = methods.binLineToAxisLine.call({ context: ownContext }, source, attribute, source, 1);

    assert.equal(singleBin.reduce((total, row) => total + row.value, 0), 160);
    assert.equal(graph.reduce((total, row) => total + row.value, 0), 160);
    assert.ok(graph.reduce((total, row) => total + row.bins.reduce((sum, value) => sum + value, 0), 0) < 160);
});

test('mapped allocation summaries follow source constraints and axis participation across breakdowns', async () => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    const axis = profile.timeline!;
    const attributes = [
        { name: 'allocationType' as const, values: new Uint32Array([0, 1, 0, 1]), dict: ['first', 'second'] },
        { name: 'allocationSpace' as const, values: new Uint8Array([0, 0, 1, 1]), dict: ['one', 'two'] }
    ];
    source.attributes = attributes;
    const context = { scopeProfile: profile, scopeLine: axis, scopeBreakdown: axis.breakdowns[0] };
    const viewport = source.breakdowns[0].populationViewport;
    const values = viewport.values;
    const totals = () => attributes.map(attribute => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 1).map(row => row.value));
    const initial = totals();
    assert.deepEqual(initial, [[64, 96], [48, 112]]);

    const alternate = new PopulationFiltered(axis.breakdowns[0].population);
    context.scopeBreakdown = { ...axis.breakdowns[0], populationViewport: alternate };
    assert.deepEqual(totals(), initial);

    alternate.setRanges([]);
    assert.deepEqual(totals(), [[0, 0], [0, 0]]);
    alternate.setRanges(null);
    assert.deepEqual(totals(), initial);

    viewport.filter.set({ key: 'test', domain: 'event', size: values.length, accepts: () => false });
    assert.deepEqual(totals(), [[0, 0], [0, 0]]);
    viewport.filter.remove('test');
    assert.deepEqual(totals(), initial);
    viewport.setValueRange(32, null);
    assert.deepEqual(totals(), [[48, 96], [32, 112]]);
    viewport.setIndexRange(1, 3);
    assert.deepEqual(totals(), [[48, 32], [32, 48]]);
    viewport.resetIndexRange();
    viewport.resetValueRange();
    assert.deepEqual(totals(), initial);

    attributes[0].values = new Uint32Array(4);
    assert.deepEqual(totals(), [[160, 0], [48, 112]]);
    attributes[0].dict.push('empty');
    assert.deepEqual(totals(), [[160, 0, 0], [48, 112]]);
    alternate.destroy();
});

test('mapping bins belong to expanded content rather than the parent panel query', async () => {
    const { profile } = await createProfileFixture();
    let mappings = 0;
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binLineToAxisLine(...args) {
                mappings += args[1] === null ? 1 : 0;
                return methods.binLineToAxisLine.apply(this, args);
            }
        }
    });
    const context = tracked(timeline.context)(profile, { primaryProfile: profile, primaryLineType: 'timeline' });
    const panel = tracked(timeline.data)(profile, context);

    assert.equal(mappings, 0);

    const mapping = timeline.content.find(view => view?.view === 'expand');
    const data = tracked(mapping.data)(panel, context);
    const rows = tracked(mapping.content.data)(data, context);

    assert.equal(mappings, profile.lines.length);
    assert.equal(rows.length, profile.lines.length);
});

test('sections own their queries without eager parent calls and retain source coverage', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const calls = [];
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binHeapTotal(...args) {
                calls.push('heap');
                return methods.binHeapTotal.apply(this, args);
            },
            binScriptFunctionCodesTotal(...args) {
                calls.push('codes');
                return methods.binScriptFunctionCodesTotal.apply(this, args);
            }
        }
    });
    const callFrameCodes = { topTier: 'Sparkplug', callFrame: {} };
    Object.assign(profile, {
        codes: [
            { tm: 5, tier: 'Ignition', callFrameCodes },
            { tm: 25, tier: 'Sparkplug', callFrameCodes }
        ],
        codesByCallFrame: [callFrameCodes]
    });
    profile.heap = { available: 200, capacity: 100, events: [{ tm: 60, event: 'new', size: 10, address: '0x1' }] };
    const context = tracked(timeline.context)(profile, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    });
    const panel = tracked(timeline.data)(profile, context);

    assert.deepEqual(calls, []);

    const heap = tracked(histHeapTotal.data)(panel, context);

    assert.deepEqual(calls, ['heap']);

    const codes = tracked(histCodes.data)(panel, context);

    assert.deepEqual(calls, ['heap', 'codes']);
    assert.equal(codes.compilations.length, 2);
    assert.equal(codes.byTier.find(tier => tier.name === 'Sparkplug').maxTier, 1);
    assert.deepEqual(codes.extent, { start: 0, end: 40 });

    assert.equal(panel.line, profile.timeline);
    assert.deepEqual(heap.extent, { start: 0, end: 60 });
    assert.equal(heap.newTotal, 10);
    const heapRows = histHeapTotal.content.content[0].content;
    assert.ok(Array.isArray(heapRows));
    for (const row of heapRows) {
        const histogram = row.content.at(-1)!;
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(heap, context), heap.extent);
    }
});

test('passes code coverage explicitly to each histogram without a context override', () => {
    const extent = { start: 10, end: 90 };
    const data = { extent, byTier: [{ name: 'Ignition', bins: [0, 1, 0] }] };
    const codeRows = histCodes.content.content[0].content;
    assert.ok(Array.isArray(codeRows));
    const [codes, functions, tiers] = codeRows;
    for (const row of [codes, functions]) {
        const histogram = row.content!.at(-1)!;
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(data), extent);
    }
    const rows = query(tiers.data!)(data);
    const histogram = tiers.item!.content.at(-1)!;
    assert.ok(histogram.extent);
    assert.equal(query(histogram.extent.slice(1))(rows[0]), extent);
    assert.equal(data.byTier[0].bins, rows[0].bins);
});

test.each([100, 1000])('shares viewport coordinates while details count actual events for duration=%i', async duration => {
    const origin = 1000;
    const { profile, line } = await createLineFixture({ origin: origin + duration * 0.2, values: new Uint32Array([duration * 0.6]) });
    const other = await createLineFixture({ origin, values: new Uint32Array([duration]) });
    const context = query(timeline.context)({}, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [other.profile, profile] }
    });
    const viewport = query('scopeViewport()')({}, context);
    assert.deepEqual(viewport, { start: origin, end: origin + duration });
    const ruler = timeline.content[0];
    assert.deepEqual(query(ruler.range.slice(1))({}, context), viewport);
    const binCount = query(ruler.segments.slice(1))({}, context);
    assert.equal(binCount, Math.min(500, duration));
    const range = query(ruler.rangeManager.slice(1))({ line }, context);
    assert.equal(range, line.range.selection);
    range.setRange(origin + duration * 0.1, origin + duration * 0.4);
    assert.deepEqual(range.ranges, [{ start: origin + duration * 0.1, end: origin + duration * 0.4 }]);
    assert.deepEqual(line.range.ranges, [{ start: -duration * 0.1, end: duration * 0.2 }]);
    const panel = query(timeline.data)(profile, context);
    for (const [start, end, count, noCoverage] of [[0, 0.1, 0, true], [0.2, 0.5, 1, false], [0.9, 1, 0, true]]) {
        const state = createState(viewport, binCount);
        const selected = selectRange(state, start, end);
        const indices = rangeToSegments(selected, state.segments)!;
        const details = query(ruler.details.context)({}, {
            ...context, detail: selected, timeStart: selected.start - viewport.start, timeEnd: selected.end - viewport.start,
            segmentStart: indices.start, segmentEnd: indices.end - 1
        });
        assert.equal(details.binStart, indices.start);
        assert.equal(details.binEnd, indices.end);
        assert.equal(details.noCoverage, noCoverage);
        const countQuery = ruler.details.content[0].content[2].content.slice('text-numeric:'.length);
        const infoContext = query(ruler.details.content[0].context)(panel, details);
        assert.equal(query(countQuery)(panel, infoContext), `Samples: ${count}`);
        const categorySection = ruler.details.content[1].content[0];
        const categoryContext = query(categorySection.context)(panel, details);
        const rows = query(categorySection.content[1].data)(panel, categoryContext);
        assert.equal(rows.reduce((total, row) => total + row.selfValue, 0), noCoverage ? 0 : duration * 0.3);
    }
});

test('profile time charts keep their viewport and selection owner when the primary line changes', async () => {
    const { profile, line: timeLine } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const { line: memline } = await createLineFixture({ type: 'memline', values: new Uint32Array([1000]) });
    assert.equal(memline.type, 'memline');
    profile.memline = memline;
    profile.lines.push(memline);
    memline.profile = profile;
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    memline.range.setRange(2, 5);
    const memorySelection = memline.range.selection.ranges;
    const charts = timeline.content.at(-1);
    assert.equal(charts.content[0], chartUsedHeap);
    assert.equal(charts.content[1], userTimingsTimeline);

    for (const selectedLine of [timeLine, memline]) {
        const parentContext = query(timeline.context)({}, {
            primaryProfile: profile, primaryLineType: selectedLine.type,
            scopeLine: selectedLine, scopeBreakdown: { line: selectedLine },
            data: { profiles: [other.profile, profile] }
        });
        const context = query(charts.context)({}, parentContext);
        assert.equal(context.scopeLine, timeLine);
        assert.equal(context.scopeBreakdown, null);
        assert.deepEqual(query('scopeViewport()')({}, context), { start: 100, end: 200 });
        assert.equal(parentContext.scopeLine, selectedLine);

        for (const chart of charts.content) {
            const data = query(chart.data)({}, context);
            if (chart === chartUsedHeap) {
                assert.deepEqual(data.extent, { start: 120, end: 180 });
                const view = chart.content.content[0].content[0];
                assert.equal(query(view.extent.slice(1))(data, context), data.extent);
                assert.equal(query(view.minX.slice(1))(data, context), 100);
                assert.equal(query(view.maxX.slice(1))(data, context), 200);
            } else {
                const view = chart.content.content[0].content[0];
                assert.equal(view.minX, undefined);
                assert.equal(view.maxX, undefined);
                assert.deepEqual(query('scopeViewport()')(data, context), { start: 100, end: 200 });
            }
        }

        query('scopeLine()')({}, context).range.selection.setRange(130, 140);
        assert.deepEqual(timeLine.range.ranges, [{ start: 10, end: 20 }]);
        assert.equal(memline.range.selection.ranges, memorySelection);
    }
});

test('a nested viewport reaches bins, ruler and time charts without being recomputed', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const scopeViewport = { start: 15, end: 25 };
    const parent = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    };
    const context = query(timeline.context)(profile, { ...parent, scopeViewport });
    const panel = query(timeline.data)(profile, context);
    const ruler = timeline.content[0];
    const chartsContext = query(timeline.content.at(-1).context)(panel, context);

    assert.equal(query('scopeViewport()')(panel, context), scopeViewport);
    assert.equal(query(ruler.range.slice(1))(panel, context), scopeViewport);
    assert.equal(panel.samples[0].bins.length, 10);
    assert.equal(query('scopeViewport()')(panel, chartsContext), scopeViewport);
    assert.deepEqual(query('scopeViewport()')({}, parent), { start: 0, end: 100 });
});
