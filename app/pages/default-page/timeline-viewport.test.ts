import assert from 'node:assert/strict';
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
import { viewportShare } from './viewport-attribute-totals.js';
import { categoriesFractionBars } from './categories-fraction-bar.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';
import * as lineWindow from '../../views/misc/line-window.js';

const methods = {
    ...appMethods,
    callAction(name, ...args) {
        return this.context.actions?.[name]?.(...args);
    }
};

const detailRenders = [];
const { timeline, section } = evaluateModule(new URL('../default.js', import.meta.url), {
    require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), chartUsedHeap, userTimingsTimeline, ...lineWindow }),
    discovery: {
        nav: { primary: { append() {} } },
        page: { define() {} },
        view: {
            getViewStackTrace: target => target?.views ?? null,
            render: (...args) => detailRenders.push(args)
        }
    }
}, '({ timeline: categoriesTimelineWindow, section: categoriesTimeline })');
const query = jora.setup({ methods: { ...methods, marker: () => ({ href: '#' }) } });
// The context of the line window the timelines are computed for, as they get it from `#.lineWindow`
const windowContext = (data, parent, evaluate = query) => {
    const value = evaluate(timeline.value)(data, parent);

    return { ...value, lineWindow: { value } };
};

test('tooltip dispatch selects one section and uses its current local data and scope', () => {
    const renderDetails = timeline.content[0].details.content[1].content.at(-1);
    const calls = detailRenders;
    const renderer = { render: renderDetails };
    calls.length = 0;
    const heap = {
        config: histHeapTotal.content,
        data: { revision: 1 },
        context: { scopeProfile: 'heap-profile', scopeLine: 'heap-line', scopeBreakdown: 'heap-breakdown' }
    };
    const codes = { config: histCodes.content, data: { revision: 2 }, context: { scopeLine: 'code-line' } };
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
    assert.equal(calls[0][1], histHeapTotal.content.rulerDetails);
    assert.equal(calls[0][2], heap.data);
    assert.equal(calls[0][3].detail, detail);
    assert.equal(calls[0][3].scopeProfile, 'heap-profile');
    assert.equal(calls[0][3].scopeLine, 'heap-line');
    assert.equal(calls[0][3].scopeBreakdown, 'heap-breakdown');

    target.views = [heap, codes];
    renderDetails.call(renderer, null, {}, {}, context);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], histCodes.content.rulerDetails);
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
    [histAllocationTypes, 'allocationType', '$.[value].sort(value desc)'],
    [histAllocationSpaces, 'allocationSpace', '$.[value].sort(name.order() asc)'],
    [histAllocationLifespan, 'allocationLifespan', '$.[value].sort(name.order() asc)'],
    [histAllocationGcs, 'allocationGcEpoch', '$.sort(name.order() asc)'],
    [histAllocationCodeType, 'allocationCodeType', '$.[value].sort(name.order() asc)']
] as const)('allocation section %# keeps whole-line rows, bins the window and labels the viewport', async (section, name, order) => {
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
    const lineTotals = attribute.dict.map((_, index) =>
        source.values.reduce((total, value, event) => total + (attribute.values[event] === index ? value : 0), 0)
    );
    const calls = [];
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binAllocationAttribute(...args) {
                calls.push(args.slice(0, 2));
                return methods.binAllocationAttribute.apply(this, args);
            }
        }
    });
    const orderRows = query(order);
    const expand = section.content;

    assert.equal(section.view, 'line-metrics-value');
    assert.equal(expand.view, 'expand');

    for (const line of profile.lines) {
        for (const breakdown of line.breakdowns) {
            const data = { profiles: [profile] };
            const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown, binCount: 7, data };
            const extent = methods.lineExtent(line);
            const length = extent.end - extent.start;

            for (const viewport of [null, [0.1, 0.6], [0.5, 1]]) {
                for (const filtered of [false, true]) {
                    if (viewport === null) {
                        line.viewport.selection.resetRange();
                    } else {
                        line.viewport.selection.setRange(extent.start + viewport[0] * length, extent.start + viewport[1] * length);
                    }

                    for (const population of [breakdown.populationViewport, breakdown.populationWindow]) {
                        population.filter.set({
                            key: 'test',
                            domain: 'event',
                            size: line.values.length,
                            accepts: Uint8Array.from({ length: line.values.length }, (_, index) => Number(!filtered || index % 2 === 0))
                        });
                    }

                    calls.length = 0;

                    // Rows don't follow the viewport, the window or filters
                    const rows = tracked(expand.data)({}, context);

                    assert.deepEqual(calls, []);
                    assert.deepEqual(rows.map(row => row.value), orderRows(rows).map(row => lineTotals[row.index]));
                    assert.deepEqual(rows, orderRows(attribute.dict.map((entry, index) => ({
                        index,
                        entry,
                        color: methods.binLineToAxisLine.call({ context }, source, attribute, line, 1)[index].color,
                        value: lineTotals[index]
                    }))));

                    // Histograms bin the line window once for all rows, each row reads its track
                    const windowBins = expand.content;
                    const binsValue = tracked(windowBins.value)(rows, query(windowBins.valueContext)(rows, { lineWindow: { value: context } }));
                    const histogram = windowBins.content.item.content.at(-1);
                    const content = rows.map(row => query(histogram.content.data)(row, { ...context, [windowBins.name]: { value: binsValue } }));
                    const bins = methods.binLineToAxisLine.call({ context }, source, attribute, line, context.binCount);

                    assert.equal(windowBins.view, 'line-metrics-value');
                    assert.equal(windowBins.metrics, '=#.lineWindow');
                    assert.equal(histogram.view, 'update-on-line-metrics-changes');
                    assert.equal(histogram.metrics, `=#.${windowBins.name}`);
                    assert.deepEqual(calls, [[name, 7]]);
                    assert.deepEqual(content.map(row => row.entry), rows.map(row => row.entry));
                    assert.deepEqual(content.map(row => [row.value, row.bins, row.max, row.step]), rows.map(row =>
                        [row.value, bins[row.index].bins, bins[row.index].max, bins[row.index].step]
                    ));

                    // Labels are shares of the viewport totals, regardless of the scope viewport
                    const tracks = methods.binLineToAxisLine.call({
                        context: { ...context, scopeViewport: methods.lineViewport(line, data.profiles) }
                    }, source, attribute, line, 1);
                    const expected = tracks.map(row => row.value);
                    const shares = tracked(section.value)(rows, { ...context, scopeViewport: { start: -100, end: 1000 } });
                    const total = expected.reduce((sum, value) => sum + value, 0);

                    assert.deepEqual(shares, { tracks, total });
                    assert.ok(viewport !== null || filtered || total > 0);

                    // The window of histogram data doesn't scope labels
                    const windows = profile.lines.flatMap(line => line.breakdowns.map(breakdown => breakdown.populationWindow));
                    const windowRanges = windows.map(population => population.ranges);

                    windows.forEach(population => population.setRanges([]));
                    assert.deepEqual(tracked(section.value)(rows, context), shares);
                    windows.forEach((population, index) => population.setRanges(windowRanges[index]));

                    for (const row of rows) {
                        assert.equal(
                            query(viewportShare)(row, { viewportTotals: { value: shares } }),
                            total ? 100 * expected[row.index] / total : 0
                        );
                    }
                }
            }

            line.viewport.selection.resetRange();
            breakdown.populationViewport.filter.remove('test');
            breakdown.populationWindow.filter.remove('test');
        }
    }

    source.attributes = [];
    assert.deepEqual(tracked(expand.data)({}, { scopeProfile: profile, scopeLine: source }), []);
    const { profile: cpuProfile } = await createProfileFixture({ cpuOnly: true });
    assert.deepEqual(tracked(expand.data)({}, { scopeProfile: cpuProfile }), []);
    assert.deepEqual(tracked(section.value)({}, { scopeProfile: cpuProfile }), { tracks: [], total: 0 });
});

test('category rows keep the whole-line set and label shares of the viewport and filters', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const breakdown = line.breakdowns[0];
    const parent = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } };
    const hub = timeline.content.find(view => view?.view === 'line-metrics-value');
    const share = hub.content.content.item.content[1].content;
    const bar = query(categoriesFractionBars.content.data);
    // Accepted events clipped to the viewport coverage, by category
    const totals = () => {
        const { samples, sinkId, ranges, population } = breakdown.populationViewport;
        const { tree, sampleToNode } = breakdown.categories!;
        const result = new Map();

        for (let event = 0; event < line.values.length; event++) {
            const start = population.cumulative[event];
            const end = start + line.values[event];
            const overlap = (ranges ?? [{ start, end }])
                .reduce((sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start)), 0);

            if (samples[event] !== sinkId && overlap > 0) {
                const category = tree.dictionary[tree.nodes[sampleToNode[samples[event]]]];

                result.set(category, (result.get(category) || 0) + overlap);
            }
        }

        return result;
    };
    const fullRows = query(timeline.data)(profile, windowContext(profile, parent)).samples.map(row => row.category);

    assert.equal(hub.name, 'viewportCategories');
    assert.equal(share.view, 'update-on-line-metrics-changes');
    assert.equal(categoriesFractionBars.view, 'update-on-line-metrics-changes');

    for (const [viewport, excluded] of [[null, []], [[10, 25], []], [[10, 25], ['script']], [[35, 40], ['script']]] as const) {
        if (viewport === null) {
            line.viewport.selection.resetRange();
        } else {
            line.viewport.selection.setRange(...viewport);
        }

        line.filters.get('category')!.setSelection('exclude', [...excluded]);

        const context = windowContext(profile, parent);
        const panel = query(timeline.data)(profile, context);
        const value = query(hub.value)(panel, context);
        const expected = totals();
        const total = [...expected.values()].reduce((sum, value) => sum + value, 0);

        assert.deepEqual(panel.samples.map(row => row.category), fullRows);
        assert.equal(value.total, total);
        assert.deepEqual(new Map(value.totals.filter(row => row.value > 0).map(row => [row.entry, row.value])), expected);

        for (const row of panel.samples) {
            const percent = total ? 100 * (expected.get(row.category) || 0) / total : 0;

            assert.equal(query(share.content.slice('text:'.length))(row, { ...context, viewportCategories: { value } }), percent.toFixed(2));
        }

        const order = breakdown.categories!.all.dict.entries.filter(entry => entry.selfValue).sort((a, b) => b.selfValue - a.selfValue);

        assert.deepEqual(bar(profile, context), order.map(({ entry }) => ({
            text: entry.name,
            color: query('name.color()')(entry),
            value: expected.get(entry) || 0,
            total
        })));
    }

    line.viewport.selection.resetRange();
    line.filters.get('category')!.setSelection('exclude', []);
});

test('GC header groups viewport shares by collection type', async () => {
    const { profile } = await createProfileFixture();
    const source = profile.memline!;
    source.attributes = [{
        name: 'allocationGcEpoch',
        values: new Uint32Array([0, 1, 2, 0]),
        dict: [
            { type: 'none', epoch: 0, color: 'red' },
            { type: 'minor', epoch: 1, color: 'blue' },
            { type: 'minor', epoch: 2, color: 'blue' }
        ]
    }];
    const context = { scopeProfile: profile, scopeLine: source, scopeBreakdown: source.breakdowns[0], binCount: 7 };
    const rows = query(histAllocationGcs.content.data)({}, context);
    const header = histAllocationGcs.content.header[1].content[1].content[0].content[0];

    assert.equal(header.view, 'update-on-line-metrics-changes');
    assert.deepEqual(query(header.content.data)(rows, { ...context, viewportTotals: { value: { tracks: [{ value: 80 }, { value: 32 }, { value: 48 }], total: 160 } } }), [
        { name: 'none', color: 'red', value: 80, total: 160 },
        { name: 'minor', color: 'blue', value: 80, total: 160 }
    ]);
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
    const details = histAllocationLifespan.content.rulerDetails;
    const detailContext = tracked(details.context)(null, { ...context, detail: { start: 8, end: 64 } });
    const rows = tracked(details.data)(null, detailContext);

    assert.deepEqual(calls, [1]);
    assert.deepEqual(rows.map(row => [row.entry, row.value, row.total]), [['alive', 8, 56], ['short-lived', 48, 56]]);
    assert.deepEqual(tracked(details.data)([], { ...detailContext, binCount: 50 }), rows);
    assert.ok(rows.every(row => !('bins' in row)));

    source.breakdowns[0].populationWindow.setRanges([{ start: 1, end: 4 }, { start: 8, end: 12 }, { start: 20, end: 25 }]);
    const clipped = tracked(details.data)([], detailContext);
    assert.deepEqual(clipped.map(row => [row.entry, row.value, row.total]), [['alive', 4, 9], ['short-lived', 5, 9]]);
    assert.equal(source.range.selection.ranges, selection);
    assert.equal('scopeViewport' in context, false);

    source.breakdowns[0].populationWindow.setRanges([]);
    assert.deepEqual(tracked(details.data)(null, detailContext), []);

    source.breakdowns[0].populationWindow.setRanges(null);
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

    axis.breakdowns[0].populationWindow.filter.set({
        key: 'test', domain: 'event', size: axis.values.length, accepts: Uint8Array.from({ length: axis.values.length }, (_, index) => Number(index !== target))
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

    context.scopeBreakdown.populationWindow.setRanges([]);

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
    const viewport = source.breakdowns[0].populationWindow;
    const values = viewport.values;
    const totals = () => attributes.map(attribute => methods.binLineToAxisLine.call({ context }, source, attribute, axis, 1).map(row => row.value));
    const initial = totals();
    assert.deepEqual(initial, [[64, 96], [48, 112]]);

    const alternate = new PopulationFiltered(axis.breakdowns[0].population);
    context.scopeBreakdown = { ...axis.breakdowns[0], populationWindow: alternate };
    assert.deepEqual(totals(), initial);

    alternate.setRanges([]);
    assert.deepEqual(totals(), [[0, 0], [0, 0]]);
    alternate.setRanges(null);
    assert.deepEqual(totals(), initial);

    viewport.filter.set({ key: 'test', domain: 'event', size: values.length, accepts: new Uint8Array(values.length) });
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
    const context = windowContext(profile, { primaryProfile: profile, primaryLineType: 'timeline' });
    const panel = tracked(timeline.data)(profile, context);

    assert.equal(mappings, 0);

    const mapping = timeline.content.find(view => view?.view === 'expand');
    const data = tracked(mapping.data)(panel, context);
    const bins = mapping.content;

    assert.equal(mappings, 0);

    const value = tracked(bins.value)(data, query(bins.valueContext)(data, context));
    const rows = query(bins.content.data)(data, { ...context, [bins.name]: { value } });
    const histogram = bins.content.content[0].content[0].item.content.at(-1);

    assert.equal(mappings, profile.lines.length);
    assert.equal(rows.length, profile.lines.length);
    assert.deepEqual(rows.map(row => query(histogram.content.data)(row, { ...context, [bins.name]: { value } })), value);
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
    const context = windowContext(profile, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    });
    const panel = tracked(timeline.data)(profile, context);

    assert.deepEqual(calls, []);

    // Bins are computed once by values of the line window, rows and their extents don't need them
    const heap = tracked(histHeapTotal.content.data)(panel, context);
    const heapBins = tracked(histHeapTotal.value)(panel, query(histHeapTotal.valueContext)(panel, context));

    assert.deepEqual(calls, ['heap']);

    const codeBins = tracked(histCodes.value)(panel, query(histCodes.valueContext)(panel, context));
    const codes = tracked(histCodes.content.data)(panel, { ...context, codeBins: { value: codeBins } });

    assert.deepEqual(calls, ['heap', 'codes']);
    assert.equal(codes.compilations.length, 2);
    assert.equal(codes.byTier.find(tier => tier.name === 'Sparkplug').maxTier, 1);
    assert.deepEqual(codes.extent, { start: 0, end: 40 });

    assert.equal(panel.line, profile.timeline);
    assert.deepEqual(heap.extent, { start: 0, end: 60 });
    assert.equal(heapBins.newTotal, 10);
    const heapRows = histHeapTotal.content.content.content[0].content;
    assert.ok(Array.isArray(heapRows));
    for (const row of heapRows) {
        const histogram = row.content.at(-1)!.content;
        const data = query(histogram.data)(heap, { ...context, heapBins: { value: heapBins } });
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(data, context), heap.extent);
        assert.ok([heapBins.totalHeapSize, heapBins.new, heapBins.delete].includes(query(histogram.bins.slice(1))(data, context)));
    }
});

test('passes code coverage explicitly to each histogram without a context override', () => {
    const extent = { start: 10, end: 90 };
    const data = { extent, byTier: [{ name: 'Ignition' }] };
    const codeBins = { compilationBins: [1], totalBins: [2], maxTotal: 2, byTier: [{ name: 'Ignition', bins: [0, 1, 0] }] };
    const context = { codeBins: { value: codeBins } };
    const codeRows = histCodes.content.content.content[0].content;
    assert.ok(Array.isArray(codeRows));
    const [codes, functions, tiers] = codeRows;
    for (const [row, bins] of [[codes, codeBins.compilationBins], [functions, codeBins.totalBins]]) {
        const histogram = row.content!.at(-1)!.content;
        const rowData = query(histogram.data)(data, context);
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(rowData), extent);
        assert.equal(query(histogram.bins.slice(1))(rowData), bins);
    }
    const rows = query(tiers.data!)(data);
    const histogram = tiers.item!.content.at(-1)!.content;
    const rowData = query(histogram.data)(rows[0], context);
    assert.ok(histogram.extent);
    assert.equal(query(histogram.extent.slice(1))(rowData), extent);
    assert.equal(rowData.bins, codeBins.byTier[0].bins);
    assert.equal(rowData.maxTotal, codeBins.maxTotal);
});

test.each([100, 1000])('shares viewport coordinates while details count actual events for duration=%i', async duration => {
    const origin = 1000;
    const { profile, line } = await createLineFixture({ origin: origin + duration * 0.2, values: new Uint32Array([duration * 0.6]) });
    const other = await createLineFixture({ origin, values: new Uint32Array([duration]) });
    const context = windowContext({}, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [other.profile, profile] }
    });
    const viewport = query('scopeViewport()')({}, context);
    assert.deepEqual(viewport, { start: origin, end: origin + duration });
    const ruler = timeline.content[0];
    assert.equal(query(ruler.window.slice(1))({}, context), context.lineWindow);
    const binCount = context.binCount;
    assert.equal(binCount, Math.min(2000, duration));
    assert.equal(ruler.zoom, true);
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
    const charts = section.content.at(-1);
    assert.equal(charts.content[0], chartUsedHeap);
    assert.equal(charts.content[1], userTimingsTimeline);

    for (const selectedLine of [timeLine, memline]) {
        const parentContext = windowContext({}, {
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

test('values of the line window follow it without rendering the section again, GC events and time charts follow the viewport', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const parent = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    };
    const line = profile.timeline;
    const bounds = methods.lineViewportBounds(line, parent.data.profiles);

    line.viewport.selection.setRange(15, 25);

    const [windowPart, events, charts] = section.content;
    const context = windowContext(profile, parent);
    const panel = query(timeline.data)(profile, context);
    const ruler = timeline.content[0];
    const window = methods.lineWindow(line, parent.data.profiles);
    const categoryBins = timeline.content.find(view => view?.name === 'viewportCategories').content;

    assert.equal(windowPart, timeline);
    assert.equal(windowPart.view, 'line-metrics-value');
    assert.equal(windowPart.name, 'lineWindow');
    assert.equal(windowPart.className, 'category-timelines-window');
    assert.equal(query(windowPart.metrics.slice(1))(profile, parent), line.breakdowns[0].populationWindow);
    assert.deepEqual(query('scopeViewport()')(panel, context), window);
    assert.notDeepEqual(window, { start: 15, end: 25 });
    assert.ok(window.start <= 15 && window.end >= 25);
    assert.equal(query(ruler.window.slice(1))(panel, context), context.lineWindow);
    assert.equal(ruler.zoom, true);
    assert.equal(categoryBins.name, 'categoryBins');
    assert.equal(categoryBins.metrics, '=#.lineWindow');
    assert.equal(query(categoryBins.value)(panel, query(categoryBins.valueContext)(panel, context)).bins[0].bins.length, context.binCount);
    // Histograms place their bins over the window they are computed for
    const histogram = categoryBins.content.item.content.at(-1).content;
    assert.deepEqual(query(histogram.viewport.slice(1))(panel.samples[0], context), window);
    assert.equal(context.binCount, Math.min(2000, Math.floor(window.end - window.start)));

    // Rendered once for the viewport bounds, they display the viewport within them
    assert.equal(events.view, 'line-intervals');
    assert.equal(events.zoom, true);
    assert.deepEqual(query('scopeViewport()')(profile, query(events.context)(profile, parent)), bounds);
    assert.deepEqual(query('scopeViewport()')(profile, query(charts.context)(profile, parent)), bounds);
    assert.equal(chartUsedHeap.content.content[0].content[0].zoom, true);
    assert.equal(userTimingsTimeline.content.content[0].content[0].zoom, true);
    line.viewport.resetRange();
    assert.deepEqual(query('scopeViewport()')({}, parent), { start: 0, end: 100 });
});
