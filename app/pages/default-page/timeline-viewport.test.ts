import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../../jora/index.mjs';
import { chartUsedHeap } from './chart-used-heap.js';
import { userTimingsTimeline } from './user-timings-timeline.js';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';
import type { SetAttributeFilter } from '../../prepare/computations/attribute-filter.js';
import { histCodes } from './hist-codes.js';
import { histHeapTotal } from './hist-heap-total.js';
import { histAllocationTypes } from './hist-allocation-types.js';
import { histAllocationSpaces } from './hist-allocation-spaces.js';
import { histAllocationLifespan } from './hist-allocation-lifespan.js';
import { histAllocationGcs } from './hist-allocation-gcs.js';
import { histAllocationCodeType } from './hist-allocation-code-type.js';
import { viewportShare } from './scope-values.js';
import { categoriesFractionBars } from './categories-fraction-bar.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';
import { findView, findViews, lineMetricsValueContext } from '../../../test/helpers/view-config.js';
import * as lineWindow from '../../views/misc/line-window.js';

const detailRenders: [unknown, unknown, unknown, object][] = [];
const { timeline, section } = evaluateModule(new URL('../default.js', import.meta.url), {
    require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), chartUsedHeap, userTimingsTimeline, ...lineWindow }),
    discovery: {
        nav: { primary: { append() {} } },
        page: { define() {} },
        view: {
            getViewStackTrace: target => target?.views ?? null,
            render: (el, config, data, context) => detailRenders.push([el, config, data, context])
        }
    }
}, '({ timeline: categoriesTimelineWindow, section: categoriesTimeline })');
const queryMethods = { ...methods, marker: () => ({ href: '#' }) };
const query = jora.setup({ methods: queryMethods });
// Queries of a `=query` property and of a `<view>:query` content
const propQuery = (value: string) => query(value.slice(1));
const contentQuery = (content: string) => query(content.slice(content.indexOf(':') + 1));

const ruler = findView(timeline, { view: 'line-ruler' });
const renderSectionDetails = findView(ruler.details, { className: 'details-sections' }).content.find(part => typeof part === 'function');
const viewportCategories = findView(timeline, { name: 'viewportCategories' });
const categoryBins = findView(timeline, { name: 'categoryBins' });
const mappingBins = findView(timeline, { name: 'mappingBins' });
const [, gcEvents, timeCharts] = section.content;

// The context of the page for the timeline of its primary profile among the profiles
function pageContext(profile, profiles = [profile]) {
    return { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles } };
}

// A profile of 4 allocations of 16, 32, 48 and 64 bytes on samples [0, 1, 1, 2] of a timeline of 3 samples over 10-40
// with the attribute values [0, 1, 0, 1]
async function createAllocationProfile(name: string, dict: unknown[]) {
    const { profile } = await createProfileFixture();
    const memline = profile.memline!;

    memline.attributes = [{ name, values: new Uint8Array([0, 1, 0, 1]), dict }] as typeof memline.attributes;

    return { profile, memline, timeline: profile.timeline! };
}

test.each([
    ['the viewport bounds without a viewport', null, null, { start: 0, end: 100 }, 100],
    ['the viewport', [{ start: 10, end: 60 }], null, { start: 10, end: 60 }, 50],
    ['the part of the viewport containing the zoom', [{ start: 10, end: 60 }], [{ start: 15, end: 25 }], { start: 10, end: 35 }, 25]
])('timelines are computed for the line window: %s', async (_, viewport, zoom, window, binCount) => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const parent = pageContext(profile, [profile, other.profile]);
    const line = profile.timeline!;

    line.viewport.selection.setRanges(viewport);
    line.zoom.selection.setRanges(zoom);

    assert.equal(propQuery(timeline.metrics)(profile, parent), line.breakdowns[0].populationWindow);
    assert.deepEqual(lineMetricsValueContext(timeline, profile, parent, query).lineWindow.value, { ...parent, scopeViewport: window, binCount });
});

test('category histograms place the bins of the line window over it', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });

    profile.timeline!.viewport.selection.setRange(10, 30);

    const context = lineMetricsValueContext(timeline, profile, pageContext(profile, [profile, other.profile]), query);
    const panel = query(timeline.data)(profile, context);
    const binsContext = lineMetricsValueContext(categoryBins, panel, context, query);
    const histogram = findView(categoryBins, { view: 'line-histogram' });
    const { value } = binsContext.categoryBins;
    const row = query(histogram.data)(panel.samples[0], binsContext);

    assert.equal(value.binSize, 1);
    assert.deepEqual(value.bins.map(category => [category.entry.name, category.bins.length]), [['root', 20], ['script', 20]]);
    assert.deepEqual([row.bins, row.binSize, row.color], [value.bins[1].bins, 1, panel.samples[0].color]);
    assert.deepEqual(propQuery(histogram.viewport)(row, binsContext), { start: 10, end: 30 });
});

test('the ruler zooms the line window and selects ranges of the line', async () => {
    const { profile, line } = await createLineFixture({ origin: 1200, values: new Uint32Array([600]) });
    const other = await createLineFixture({ origin: 1000, values: new Uint32Array([1000]) });
    const context = lineMetricsValueContext(timeline, profile, pageContext(profile, [other.profile, profile]), query);
    const selection = propQuery(ruler.rangeManager)({ line }, context);

    selection.setRange(1100, 1400);

    assert.equal(ruler.zoom, true);
    assert.equal(propQuery(ruler.window)(null, context), context.lineWindow);
    assert.equal(selection, line.range.selection);
    assert.deepEqual(line.range.ranges, [{ start: -100, end: 200 }]);
});

// A line of a sample over 1200-1800 within recordings of 1000-2000 is binned by units of time
test.each([
    ['before the samples', 1000, 1100, true, 0, 0, 'no-time'],
    ['ending at the start of the samples', 1100, 1200, true, 0, 0, 'no-time'],
    ['with the start of a sample', 1200, 1500, false, 1, 300, undefined],
    ['starting at the end of the samples', 1800, 1900, true, 0, 0, 'no-time'],
    ['after the samples', 1900, 2000, true, 0, 0, 'no-time']
])('ruler details of a range %s count its samples and category values', async (_, start, end, noCoverage, sampleCount, selfValue, className) => {
    const { profile } = await createLineFixture({ origin: 1200, values: new Uint32Array([600]) });
    const other = await createLineFixture({ origin: 1000, values: new Uint32Array([1000]) });
    const context = lineMetricsValueContext(timeline, profile, pageContext(profile, [other.profile, profile]), query);
    const panel = query(timeline.data)(profile, context);
    const info = findView(ruler.details, { className: 'timeline-segment-info' });
    const [, duration, samples] = info.content;
    const [categories] = findViews(ruler.details, { className: 'details-section' });
    const categoryList = findView(categories, { className: 'category-timings-list' });
    const [, categoryMetric] = categoryList.itemConfig.content;
    // The context line-ruler gives details of the grid of the line window
    const details = query(ruler.details.context)(panel, {
        ...context,
        scopeViewport: context.lineWindow.value.scopeViewport,
        binCount: context.lineWindow.value.binCount,
        detail: { start, end },
        timeStart: start - 1000,
        timeEnd: end - 1000,
        segmentStart: start - 1000,
        segmentEnd: end - 1000 - 1
    });
    const infoContext = query(info.context)(panel, details);
    const categoryContext = query(categories.context)(panel, details);
    const rows = query(categoryList.data)(panel, categoryContext);

    assert.deepEqual([details.binStart, details.binEnd, details.noCoverage], [start - 1000, end - 1000, noCoverage]);
    assert.equal(contentQuery(samples.content)(panel, infoContext), `Samples: ${sampleCount}`);
    assert.equal(contentQuery(duration.content[1])(panel, infoContext).time, end - start);
    assert.deepEqual(rows.map(row => [row.category.name, row.selfValue]), [['script', selfValue]]);
    assert.equal(contentQuery(categoryMetric)(rows[0], categoryContext).total, end - start);
    assert.equal(propQuery(categoryList.itemConfig.className)(rows[0]), className);
});

test('ruler details show used heap sizes of the range with values interpolated at its edges', () => {
    const [, usedHeap] = findViews(ruler.details, { className: 'details-section' });
    const [range, changes] = findViews(usedHeap, { view: 'labeled-value-list' });
    const counters = [{ name: 'used-heap-size', values: [
        { tm: 0, value: 100, event: null },
        { tm: 10, value: 300, event: null },
        { tm: 20, value: 200, event: null },
        { tm: 30, value: 500, event: null }
    ] }];
    const data = query(usedHeap.data)(null, {
        scopeProfile: { thread: { counters } },
        scopeViewport: { start: 0, end: 40 },
        timeStart: 5,
        timeEnd: 25
    });

    assert.deepEqual(data.points, [
        { x: 5, y: 200, event: null },
        { x: 10, y: 300, event: null },
        { x: 20, y: 200, event: null },
        { x: 25, y: 350, event: null }
    ]);
    assert.deepEqual(query(range.data)(data), [{ label: 'Range', value: '200b – 350b' }, { label: 'Range size', value: '150b' }]);
    assert.deepEqual(query(changes.data)(data), [
        { label: 'Allocated', value: '250b' },
        { label: 'Garbage Collected', value: '100b' },
        { label: 'Net Change', value: '150b' }
    ]);
});

const heapSection = { config: findView(histHeapTotal, { view: 'expand' }), data: { revision: 1 }, context: { scopeLine: 'heap-line' } };
const codesSection = { config: histCodes.content, data: { revision: 2 }, context: { scopeLine: 'code-line' } };
const plainView = { config: {}, data: null, context: {} };
const rulerContext = {
    ruler: { selection: null },
    detail: { start: 20, end: 30 },
    binStart: 2,
    binEnd: 3,
    scopeLine: 'parent-line'
};

test.each([
    ['the innermost section', [heapSection, codesSection], codesSection],
    ['a section under views without details', [heapSection, plainView], heapSection]
])('ruler details render the details of %s with its data and context', (_, views, expected) => {
    detailRenders.length = 0;
    renderSectionDetails(null, {}, {}, { ...rulerContext, detailTarget: { views } });

    // Contexts of the evaluated page are spread to compare them by their own values
    assert.deepEqual(detailRenders.map(([el, config, data, context]) => [el, config, data, { ...context }]), [[null, expected.config.rulerDetails, expected.data, {
        ...expected.context,
        ruler: rulerContext.ruler,
        detail: rulerContext.detail,
        binStart: 2,
        binEnd: 3
    }]]);
});

test.each([
    ['views without details', { views: [plainView] }],
    ['no views', { views: [] }],
    ['no target', null]
])('ruler details render no section details for %s', (_, detailTarget) => {
    detailRenders.length = 0;
    renderSectionDetails(null, {}, {}, { ...rulerContext, detailTarget });

    assert.deepEqual(detailRenders, []);
});

const categoryEntry = (name: string, totalValue: number, selfValue: number) => ({ entry: { name }, totalValue, selfValue });

test.each([
    ['without own samples of the root', 0, ['script', 'npm', 'gc']],
    ['with own samples of the root', 5, ['script', 'npm', 'gc', 'root']]
])('category rows are the categories of the line with samples in category order, %s', (_, rootSelfValue, expected) => {
    const breakdown = { line: { axisTotal: 100 }, categories: { all: { dict: { entries: [
        categoryEntry('gc', 10, 10),
        categoryEntry('root', 100, rootSelfValue),
        categoryEntry('idle', 0, 0),
        categoryEntry('npm', 50, 0),
        categoryEntry('script', 40, 40)
    ] } } } };
    const panel = query(timeline.data)(null, { scopeBreakdown: breakdown });

    assert.deepEqual(panel.samples.map(row => [row.category.name, row.totalValue]), expected.map(name => [name, 100]));
});

test.each([
    ['the whole line', null, [], 30, '100.00'],
    ['a viewport', [{ start: 10, end: 25 }], [], 15, '100.00'],
    ['a viewport with an excluded category', [{ start: 10, end: 25 }], ['script'], 0, '0.00']
])('category labels and fraction bars follow %s', async (_, viewport, excluded, total, share) => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const parent = pageContext(profile);
    const shareText = findView(viewportCategories, { className: 'total-percent' }).content;

    line.viewport.selection.setRanges(viewport);
    (line.filters.get('category') as SetAttributeFilter).setSelection('exclude', excluded);

    const context = lineMetricsValueContext(timeline, profile, parent, query);
    const panel = query(timeline.data)(profile, context);
    const labelContext = lineMetricsValueContext(viewportCategories, panel, context, query);
    const { value } = labelContext.viewportCategories;

    assert.equal(propQuery(viewportCategories.metrics)(panel, context), line.breakdowns[0].populationViewport);
    assert.equal(propQuery(categoriesFractionBars.metrics)(profile, parent), line.breakdowns[0].populationViewport);
    assert.deepEqual(panel.samples.map(row => row.category.name), ['script']);
    assert.deepEqual(value.totals.map(row => [row.entry.name, row.value]), [['root', 0], ['script', total]]);
    assert.equal(value.total, total);
    assert.equal(contentQuery(shareText.content)(panel.samples[0], labelContext), share);
    assert.deepEqual(query(categoriesFractionBars.content.data)(profile, parent), [
        { text: 'script', color: methods.color('script'), value: total, total }
    ]);
});

test('fraction bars order the viewport totals of categories by their self values over the whole line', () => {
    const [script, gc, npm] = [{ name: 'script' }, { name: 'gc' }, { name: 'npm' }];
    const totals = [{ entry: script, value: 15 }, { entry: gc, value: 5 }, { entry: npm, value: 0 }];
    const barsQuery = jora.setup({ methods: { ...queryMethods, dimensionSampleTotals: () => totals } });
    const breakdown = { categories: { all: { dict: { entries: [
        { entry: script, selfValue: 40 },
        { entry: gc, selfValue: 10 },
        { entry: { name: 'idle' }, selfValue: 0 },
        { entry: npm, selfValue: 50 }
    ] } } } };

    assert.deepEqual(barsQuery(categoriesFractionBars.content.data)(null, { scopeBreakdown: breakdown }), [
        { text: 'npm', color: methods.color('npm'), value: 0, total: 20 },
        { text: 'script', color: methods.color('script'), value: 15, total: 20 },
        { text: 'gc', color: methods.color('gc'), value: 5, total: 20 }
    ]);
});

test('line mapping bins of every line are computed by the expanded control', async () => {
    const { profile } = await createProfileFixture();
    const calls: unknown[][] = [];
    const recording = jora.setup({
        methods: {
            ...queryMethods,
            binLineToAxisLine(...args) {
                calls.push(args);
                return methods.binLineToAxisLine.apply(this, args);
            }
        }
    });
    const context = lineMetricsValueContext(timeline, profile, pageContext(profile), query);
    const control = findView(timeline, { content: mappingBins });
    const histogram = findView(mappingBins, { view: 'line-histogram' });
    const rows = findView(mappingBins, { view: 'switch' });
    const panel = recording(timeline.data)(profile, context);
    const lines = recording(control.data)(panel, context);

    assert.equal(calls.length, 0);

    const binsContext = lineMetricsValueContext(mappingBins, lines, context, recording);
    const { value } = binsContext.mappingBins;

    assert.deepEqual(calls, [[profile.timeline, null, profile.timeline, 40], [profile.memline, null, profile.timeline, 40]]);
    assert.deepEqual(query(rows.data)(lines, binsContext), [{ entry: 'timeline', step: 1 }, { entry: 'memline', step: null }]);
    assert.equal(query(histogram.data)({ entry: 'memline' }, binsContext), value[1]);
});

test.each([
    ['the whole line', null, null, { start: 0, end: 40 }, { minTotal: 100, maxTotal: 160, newTotal: 70, deleteTotal: 10 }, { min: 100, max: 500, maxY: 600, up: 500, down: 100 }],
    ['a viewport', [{ start: 10, end: 30 }], null, { start: 10, end: 30 }, { minTotal: 110, maxTotal: 130, newTotal: 20, deleteTotal: 10 }, { min: 200, max: 500, maxY: 600, up: 300, down: 100 }],
    ['a viewport, not a zoom within it', [{ start: 10, end: 30 }], [{ start: 12, end: 14 }], { start: 10, end: 15 }, { minTotal: 110, maxTotal: 130, newTotal: 20, deleteTotal: 10 }, { min: 200, max: 500, maxY: 600, up: 300, down: 100 }]
])('heap totals and used heap stats follow %s', async (_, viewport, zoom, window, heapTotals, usedHeap) => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const context = { ...pageContext(profile), scopeLine: line };

    profile.heap = {
        available: 1000,
        capacity: 100,
        events: [
            { tm: 5, event: 'new', size: 10, address: '0x1' },
            { tm: 15, event: 'new', size: 20, address: '0x2' },
            { tm: 25, event: 'delete', size: 10, address: '0x1' },
            { tm: 35, event: 'new', size: 40, address: '0x3' }
        ]
    };
    profile.thread = { counters: [
        { name: 'used-heap-size', values: [{ tm: 0, value: 100, event: null }, { tm: 10, value: 300, event: null }, { tm: 20, value: 200, event: null }, { tm: 30, value: 500, event: null }] },
        { name: 'total-heap-size', values: [{ tm: 0, value: 400, event: null }, { tm: 30, value: 600, event: null }] }
    ] } as typeof profile.thread;
    line.viewport.selection.setRanges(viewport);
    line.zoom.selection.setRanges(zoom);

    assert.deepEqual(methods.lineWindow(line, [profile]), window);
    assert.equal(propQuery(histHeapTotal.metrics)(null, context), line.viewport);
    assert.equal(propQuery(chartUsedHeap.metrics)(null, context), line.viewport);
    assert.deepEqual(lineMetricsValueContext(histHeapTotal, null, context, query).heapScope.value, heapTotals);
    assert.deepEqual(lineMetricsValueContext(chartUsedHeap, null, context, query).usedHeapScope.value, usedHeap);
});

test('the used heap scale covers used sizes above the total size', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });

    profile.thread = { counters: [
        { name: 'used-heap-size', values: [{ tm: 0, value: 100, event: null }, { tm: 20, value: 700, event: null }] },
        { name: 'total-heap-size', values: [{ tm: 0, value: 400, event: null }, { tm: 20, value: 600, event: null }] }
    ] } as typeof profile.thread;

    assert.equal(lineMetricsValueContext(chartUsedHeap, null, { ...pageContext(profile), scopeLine: profile.timeline }, query).usedHeapScope.value.maxY, 700);
});

test('the used heap chart is scaled to the stats of the viewport and labels them', () => {
    const value = { min: 100, max: 500, maxY: 600, up: 500, down: 100 };
    const chart = findView(chartUsedHeap, { view: 'cpupro-chart' });
    const [range, changes] = findViews(chartUsedHeap, { view: 'labeled-value-list' });
    const context = { usedHeapScope: { value }, scopeViewport: { start: 10, end: 30 } };

    assert.equal(chart.zoom, true);
    assert.deepEqual([chart.minY, chart.maxY, chart.minX, chart.maxX].map(prop => propQuery(prop)(null, context)), [100, 600, 10, 30]);
    assert.deepEqual(query(range.data)(value), [{ label: 'Range', value: '100b – 500b' }, { label: 'Range size', value: '400b' }]);
    assert.deepEqual(query(changes.data)(value), [
        { label: 'Allocated', value: '500b' },
        { label: 'Garbage Collected', value: '100b' },
        { label: 'Net Change', value: '400b' }
    ]);
});

test('heap histograms bin heap events of the window beyond the samples over their extent', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const heapBins = findView(histHeapTotal, { name: 'heapBins' });
    const histograms = findViews(heapBins, { view: 'line-histogram' });

    profile.heap = { available: 200, capacity: 100, events: [{ tm: 60, event: 'new', size: 10, address: '0x1' }] };

    const context = lineMetricsValueContext(timeline, profile, pageContext(profile, [profile, other.profile]), query);
    const binsContext = lineMetricsValueContext(heapBins, null, context, query);
    const { value } = binsContext.heapBins;
    const data = query(heapBins.content.data)(null, binsContext);
    const rows = histograms.map(histogram => query(histogram.data)(data, binsContext));

    assert.deepEqual(data, { available: 200, extent: { start: 0, end: 60 } });
    assert.deepEqual([value.new.length, value.new.reduce((sum, size) => sum + size, 0)], [100, 10]);
    assert.deepEqual(histograms.map((histogram, index) => propQuery(histogram.extent)(rows[index])), [data.extent, data.extent, data.extent]);
    assert.deepEqual(histograms.map((histogram, index) => propQuery(histogram.bins)(rows[index])), [value.totalHeapSize, value.new, value.delete]);
});

test('heap details show the sizes of the selected bins among the viewport totals', () => {
    const details = findView(histHeapTotal, { className: 'details-section' });
    const list = findView(details, { className: 'category-timings-list with-from' });
    const context = {
        heapBins: { value: { totalHeapSize: [10, 30, 20, 40], new: [5, 10, 0, 3], delete: [0, 0, 0, 1] } },
        heapScope: { value: { maxTotal: 50, newTotal: 18, deleteTotal: 1 } },
        binStart: 1,
        binEnd: 3
    };
    const rows = query(list.data)(null, context);

    assert.deepEqual(rows, [
        { name: 'Total size', value: 30, from: 20, total: 50 },
        { name: 'Allocated', value: 10, total: 18 },
        { name: 'Released', value: 0, total: 1 }
    ]);
    assert.deepEqual(rows.map(row => propQuery(list.itemConfig.className)(row)), [undefined, undefined, 'no-value']);
});

test('code states are binned for the window and their tiers count functions by their top tier', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const ignition = { topTier: 'Ignition', callFrame: { id: 1 } };
    const sparkplug = { topTier: 'Sparkplug', callFrame: { id: 2 } };
    const tierShares = findView(histCodes, { className: 'labeled-value-group', view: 'inline-list' });
    const tierRows = findView(histCodes, { className: 'category-timelines-list' });
    const tierRowShare = findView(tierRows, { className: 'total-percent' });

    Object.assign(profile, {
        codes: [
            { tm: 5, tier: 'Ignition', callFrame: ignition.callFrame, callFrameCodes: ignition },
            { tm: 6, tier: 'Ignition', callFrame: sparkplug.callFrame, callFrameCodes: sparkplug },
            { tm: 25, tier: 'Sparkplug', callFrame: sparkplug.callFrame, callFrameCodes: sparkplug }
        ],
        codesByCallFrame: [ignition, sparkplug, { topTier: 'Sparkplug', callFrame: { id: 3 } }]
    });

    const context = lineMetricsValueContext(histCodes, null, lineMetricsValueContext(timeline, profile, pageContext(profile), query), query);
    const data = query(histCodes.content.data)(null, context);

    assert.equal(context.codeBins.value.totalBins.length, 40);
    assert.deepEqual([data.functionCount, data.compilations.length, data.extent], [3, 3, { start: 0, end: 40 }]);
    assert.deepEqual(data.byTier.map(tier => [tier.name, tier.maxTier]), [['Ignition', 1], ['Sparkplug', 2]]);
    assert.deepEqual(query(tierShares.data)(data).map(tier => contentQuery(tierShares.itemConfig.value)(tier)), ['33.33%', '66.67%']);
    assert.deepEqual(query(tierRows.data)(data).map(tier => contentQuery(tierRowShare.content)(tier)), ['33.33', '66.67']);
});

test('code histograms take the extent of the codes and the bins of the window', () => {
    const extent = { start: 10, end: 90 };
    const data = { extent, byTier: [{ name: 'Ignition' }] };
    const codeBins = { compilationBins: [1], totalBins: [2], maxTotal: 2, byTier: [{ name: 'Sparkplug', bins: [1, 0, 1] }, { name: 'Ignition', bins: [0, 1, 0] }] };
    const context = { codeBins: { value: codeBins } };
    const histograms = findViews(histCodes, { view: 'line-histogram' });
    const tierRows = findView(histCodes, { className: 'category-timelines-list' });
    const [tier] = query(tierRows.data)(data);
    const rows = [data, data, tier].map((row, index) => query(histograms[index].data)(row, context));

    assert.deepEqual(histograms.map((histogram, index) => propQuery(histogram.extent)(rows[index])), [extent, extent, extent]);
    assert.deepEqual(histograms.map((histogram, index) => propQuery(histogram.bins)(rows[index])), [codeBins.compilationBins, codeBins.totalBins, [0, 1, 0]]);
    assert.equal(rows[2].totalBins, codeBins.totalBins);
});

test('code details show the code counts of tiers in the selected bins', () => {
    const details = findView(histCodes, { className: 'details-section' });
    const list = findView(details, { className: 'category-timings-list with-from' });
    const [from] = findViews(list.itemConfig, { view: 'text-numeric' });
    const data = {
        totalColor: 'total',
        byTier: [{ name: 'Ignition', color: 'i' }, { name: 'Maglev', color: 'm' }, { name: 'Sparkplug', color: 's' }]
    };
    const context = {
        codeBins: { value: {
            totalBins: [1, 3, 2, 5],
            byTier: [{ name: 'Sparkplug', bins: [0, 1, 2, 1] }, { name: 'Ignition', bins: [1, 2, 0, 4] }, { name: 'Maglev', bins: [5, 0, 0, 5] }]
        } },
        binStart: 1,
        binEnd: 3
    };
    const rows = query(list.data)(data, context);

    assert.deepEqual(rows, [
        { name: 'Ignition', color: 'i', value: 2, from: 0, maxTotal: 3 },
        { name: 'Maglev', color: 'm', value: 0, from: 0, maxTotal: 3 },
        { name: 'Sparkplug', color: 's', value: 2, from: 1, maxTotal: 3 },
        { name: 'Total', value: 3, from: 2, maxTotal: 3, color: 'total' }
    ]);
    assert.deepEqual(rows.map(row => propQuery(list.itemConfig.className)(row)), [undefined, 'no-value', undefined, undefined]);
    assert.deepEqual(rows.map(row => query(from.when)(row)), [true, false, true, true]);
});

const gcEpochs = [{ type: 'none', epoch: 0, color: 'red' }, { type: 'minor', epoch: 1, color: 'blue' }];
const allocationSpaces = [{ code: 'new', name: 'New', color: 'red' }, { code: 'old', name: 'Old', color: 'blue' }];

// Allocation sections with rows of the whole line of a profile with the attribute values [0, 1, 0, 1]:
// totals of 16 + 48 and 32 + 64 bytes in the order of the dictionary, allocation types by their totals
test.each([
    ['allocationType', histAllocationTypes, ['small', 'large', 'unused'], [['large', 96], ['small', 64]]],
    ['allocationSpace', histAllocationSpaces, allocationSpaces, [[allocationSpaces[0], 64], [allocationSpaces[1], 96]]],
    ['allocationLifespan', histAllocationLifespan, ['alive', 'short-lived'], [['alive', 64], ['short-lived', 96]]],
    ['allocationGcEpoch', histAllocationGcs, gcEpochs, [[gcEpochs[0], 64], [gcEpochs[1], 96]]],
    ['allocationCodeType', histAllocationCodeType, ['Ignition', 'Sparkplug'], [['Ignition', 64], ['Sparkplug', 96]]]
] as const)('%s rows are whole-line totals regardless of the viewports, the window and filters', async (name, allocationSection, dict, expected) => {
    const { profile, memline, timeline: axis } = await createAllocationProfile(name, [...dict]);
    const context = { ...pageContext(profile), scopeLine: axis, scopeBreakdown: axis.breakdowns[0] };
    const rows = () => query(allocationSection.content.data)(null, context).map(row => [row.entry, row.value]);

    assert.deepEqual(rows(), expected);

    memline.viewport.selection.setRange(0, 50);
    axis.viewport.selection.setRange(15, 25);
    memline.breakdowns[0].populationWindow.setRanges([]);
    memline.breakdowns[0].populationViewport.filter.set({ key: 'test', domain: 'event', size: 4, accepts: new Uint8Array(4) });

    assert.deepEqual(rows(), expected);
});

test.each([
    ['allocationType', histAllocationTypes],
    ['allocationSpace', histAllocationSpaces],
    ['allocationLifespan', histAllocationLifespan],
    ['allocationGcEpoch', histAllocationGcs],
    ['allocationCodeType', histAllocationCodeType]
] as const)('the %s section bins the window for all rows, which read their tracks, and labels the viewport', async (name, allocationSection) => {
    const { profile, timeline: axis } = await createAllocationProfile(name, ['first', 'second']);
    const attributeBins = findView(allocationSection, { name: 'attributeBins' });
    const histogram = findView(attributeBins, { view: 'line-histogram' });
    const context = lineMetricsValueContext(timeline, profile, { ...pageContext(profile), scopeLine: axis, scopeBreakdown: axis.breakdowns[0] }, query);
    const rows = query(allocationSection.content.data)(null, context);
    const binsContext = lineMetricsValueContext(attributeBins, rows, context, query);
    const tracks = binsContext.attributeBins.value;

    assert.deepEqual(tracks.map(track => [track.entry, track.bins.length]), [['first', 40], ['second', 40]]);
    assert.deepEqual(rows.map(row => query(histogram.data)(row, binsContext)), rows.map(row => ({
        ...row,
        bins: tracks[row.index].bins,
        totalBins: tracks[row.index].totalBins,
        step: tracks[row.index].step
    })));
    const { value } = lineMetricsValueContext(allocationSection, null, context, query).viewportTotals;

    assert.deepEqual([value.tracks.map(track => [track.entry, track.value]), value.total], [[['first', 64], ['second', 96]], 160]);
});

test.each([
    ['memline', [{ start: 0, end: 50 }], [18, 32, 0], 50],
    ['timeline', [{ start: 15, end: 25 }], [48, 32, 0], 80]
] as const)('allocation labels on a %s are totals of its viewport, regardless of the window and the scope viewport', async (lineType, viewport, totals, total) => {
    const { profile, memline } = await createAllocationProfile('allocationType', ['small', 'large', 'unused']);
    const line = profile[lineType]!;
    const context = { ...pageContext(profile), scopeLine: line, scopeBreakdown: line.breakdowns[0] };
    const memlineViewport = (kind: string) => memline.breakdowns
        .find(breakdown => breakdown.kind === kind)!
        .populationViewport;

    line.viewport.selection.setRanges(viewport);
    profile.timeline!.breakdowns[0].populationWindow.setRanges([]);
    memline.breakdowns[0].populationWindow.setRanges([]);

    const { value } = lineMetricsValueContext(histAllocationTypes, null, { ...context, scopeViewport: { start: -100, end: 1000 } }, query).viewportTotals;

    // Viewports of the memline follow its breakdowns: call stacks and locations, source-mapped ones share them
    assert.deepEqual(propQuery(histAllocationTypes.metrics)(null, context), [
        line.breakdowns[0].populationViewport,
        memlineViewport('call-stack'),
        memlineViewport('location')
    ]);
    assert.deepEqual([value.tracks.map(track => track.value), value.total], [totals, total]);
});

const viewportTotals = { tracks: [{ value: 1 }, { value: 3 }, { value: 0 }], total: 4 };

test.each([
    ['a track', viewportTotals, 1, 75, '75.00%', '75.00'],
    ['a track without a value', viewportTotals, 2, 0, '0.00%', '0.00'],
    ['no totals', { tracks: [], total: 0 }, 0, 0, '0.00%', '0.00']
])('allocation labels show the share of %s among the viewport totals', (_, value, index, share, label, rowLabel) => {
    const context = { viewportTotals: { value } };
    const header = findView(histAllocationTypes, { view: 'labeled-value' });
    const row = findView(histAllocationTypes, { className: 'total-percent' }).content;

    assert.equal(query(viewportShare)({ index }, context), share);
    assert.equal(contentQuery(header.value)({ index }, context), label);
    assert.equal(contentQuery(row.content)({ index }, context), rowLabel);
});

test('allocation sections are empty without the attribute or the memline', async () => {
    const { profile } = await createProfileFixture();
    const { profile: cpuProfile } = await createProfileFixture({ cpuOnly: true });
    const sectionData = (context: object) => [
        query(histAllocationTypes.content.data)(null, context),
        query('"allocationType".binAllocationAttribute(7)')(null, context),
        lineMetricsValueContext(histAllocationTypes, null, context, query).viewportTotals.value
    ];

    profile.memline!.attributes = [];

    assert.deepEqual(sectionData(pageContext(profile)), [[], [], { tracks: [], total: 0, columnMax: null }]);
    assert.deepEqual(sectionData(pageContext(cpuProfile)), [[], [], { tracks: [], total: 0, columnMax: null }]);
});

test('allocation type rows and labels take their color or a random one of the entry', () => {
    const label = findView(histAllocationTypes, { view: 'labeled-value' });
    const item = findView(histAllocationTypes, { className: 'category-timelines-item' });
    const random = methods.colorRand('large');

    assert.deepEqual([propQuery(label.color)({ entry: 'large', color: 'red' }), query(item.data)({ entry: 'large', color: 'red' }).color], ['red', 'red']);
    assert.deepEqual([propQuery(label.color)({ entry: 'large' }), query(item.data)({ entry: 'large' }).color], [random, random]);
});

test('the GC header groups viewport shares by collection type', () => {
    const header = findView(histAllocationGcs, { view: 'inline-list' });
    const rows = [
        { index: 0, entry: { type: 'none', epoch: 0, color: 'red' } },
        { index: 1, entry: { type: 'minor', epoch: 1, color: 'blue' } },
        { index: 2, entry: { type: 'minor', epoch: 2, color: 'blue' } }
    ];
    const groups = query(header.data)(rows, { viewportTotals: { value: { tracks: [{ value: 40 }, { value: 32 }, { value: 48 }], total: 120 } } });

    assert.deepEqual(groups, [
        { name: 'none', color: 'red', value: 40, total: 120 },
        { name: 'minor', color: 'blue', value: 80, total: 120 }
    ]);
    assert.deepEqual(groups.map(group => contentQuery(header.itemConfig.value)(group)), ['33.33%', '66.67%']);
    assert.equal(contentQuery(header.itemConfig.value)({ value: 0, total: 0 }), '0.00%');
});

test.each([
    [{ type: 'none', epoch: 0 }, 'survived', 'alive'],
    [{ type: 'minor', epoch: 3 }, 'minor #3', 'short-lived'],
    [{ type: 'major', epoch: 4 }, 'major #4', 'long-lived']
])('GC rows of %o are labeled and colored by the collection', (entry, label, lifespan) => {
    const item = findView(histAllocationGcs, { className: 'category-timelines-item' });
    const histogram = findView(item, { view: 'line-histogram' });

    assert.equal(contentQuery(findView(item, { className: 'label' }).content)({ entry }), label);
    assert.equal(propQuery(histogram.color)({ entry }), methods.color(lifespan));
});

const lifespanDetails = histAllocationLifespan.content.rulerDetails;
const lifespanRow = (entry: string, value: number, total: number) => ({ entry, color: methods.color(entry), value, total });

// Allocations of 16, 32, 48 and 64 bytes over 0-160 are alive, short-lived, alive and short-lived
test.each([
    ['the range', null, [lifespanRow('alive', 24, 56), lifespanRow('short-lived', 32, 56)]],
    ['the range within the window', [{ start: 1, end: 4 }, { start: 8, end: 12 }, { start: 20, end: 25 }], [lifespanRow('alive', 4, 9), lifespanRow('short-lived', 5, 9)]],
    ['the range within an empty window', [], []]
])('lifespan details of a memline range sum %s regardless of display bins', async (_, window, expected) => {
    const { profile, memline } = await createAllocationProfile('allocationLifespan', ['alive', 'short-lived', 'long-lived']);
    const context = { ...pageContext(profile), scopeLine: memline, scopeBreakdown: memline.breakdowns[0], detail: { start: 8, end: 64 } };

    memline.breakdowns[0].populationWindow.setRanges(window);

    assert.deepEqual(query(lifespanDetails.data)(null, query(lifespanDetails.context)(null, { ...context, binCount: 7 })), expected);
    assert.deepEqual(query(lifespanDetails.data)(null, query(lifespanDetails.context)(null, { ...context, binCount: 50 })), expected);
});

// Allocations are on the samples [0, 1, 1, 2] starting at 10, 20 and 30
test.each([
    ['before the samples', { start: 0, end: 10 }, [1, 1, 1], []],
    ['with the start of the first sample', { start: 10, end: 11 }, [1, 1, 1], [lifespanRow('alive', 16, 16)]],
    ['with the start of the second sample', { start: 20, end: 30 }, [1, 1, 1], [lifespanRow('alive', 48, 80), lifespanRow('short-lived', 32, 80)]],
    ['with the start of a sample the window rejects', { start: 20, end: 30 }, [1, 0, 1], []]
])('lifespan details of a timeline range sum allocations of the samples %s', async (_, detail, accepts, expected) => {
    const { profile, timeline: axis } = await createAllocationProfile('allocationLifespan', ['alive', 'short-lived', 'long-lived']);
    const context = { ...pageContext(profile), scopeLine: axis, scopeBreakdown: axis.breakdowns[0], detail };

    axis.breakdowns[0].populationWindow.filter.set({ key: 'test', domain: 'event', size: 3, accepts: new Uint8Array(accepts) });

    assert.deepEqual(query(lifespanDetails.data)(null, query(lifespanDetails.context)(null, context)), expected);
});

const heapExpand = findView(histHeapTotal, { view: 'expand' });
const codesExpand = findView(histCodes, { view: 'expand' });
const [, heapSizeRange] = findView(histHeapTotal, { view: 'labeled-value', text: 'Total size' }).value;
const userTimingsNote = findView(userTimingsTimeline.header, { view: 'context' });

test.each([
    ['code states for a timeline', codesExpand.when, null, { primaryLineType: 'timeline' }, true],
    ['code states for a memline', codesExpand.when, null, { primaryLineType: 'memline' }, false],
    ['heap sizes for a timeline', heapExpand.when, null, { primaryLineType: 'timeline' }, true],
    ['heap sizes for a memline', heapExpand.when, null, { primaryLineType: 'memline' }, false],
    ['the range of different heap sizes', heapSizeRange.when, { minTotal: 1, maxTotal: 2 }, {}, true],
    ['the range of equal heap sizes', heapSizeRange.when, { minTotal: 2, maxTotal: 2 }, {}, false],
    ['the line mapping control of a profile with several lines', findView(timeline, { content: mappingBins }).when, null, { scopeProfile: { lines: [1, 2] } }, true],
    ['the line mapping control of a profile with a line', findView(timeline, { content: mappingBins }).when, null, { scopeProfile: { lines: [1] } }, false],
    ['GC events of a timeline', gcEvents.when, null, { scopeLine: { type: 'timeline' } }, true],
    ['GC events of a memline', gcEvents.when, null, { scopeLine: { type: 'memline' } }, false],
    ['the unavailability note of user timings without spans', userTimingsNote.when, { spans: [] }, {}, true],
    ['the unavailability note of user timings with spans', userTimingsNote.when, { spans: [{}] }, {}, false]
])('timelines show %s: %s', (_, when, data, context, expected) => {
    assert.equal(query(when)(data, context), expected);
});

test.each([
    ['code states', codesExpand.className, null, 'unavailable'],
    ['code states', codesExpand.className, { functionCount: 1 }, undefined],
    ['heap sizes', heapExpand.className, null, 'unavailable'],
    ['heap sizes', heapExpand.className, { available: 1 }, undefined],
    ['used heap sizes', chartUsedHeap.content.className, { points: [] }, 'unavailable'],
    ['used heap sizes', chartUsedHeap.content.className, { points: [{}] }, undefined],
    ['user timings', userTimingsTimeline.className, { spans: [] }, 'user-timings-timeline unavailable'],
    ['user timings', userTimingsTimeline.className, { spans: [{}] }, 'user-timings-timeline ']
])('the class of %s for %o is %s', (_, className, data, expected) => {
    assert.equal(propQuery(className)(data), expected);
});

test('GC events and time charts are rendered for the viewport bounds, the zoom is displayed within them', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const parent = pageContext(profile, [profile, other.profile]);

    profile.timeline!.viewport.selection.setRange(10, 60);
    profile.timeline!.zoom.selection.setRange(15, 25);

    assert.deepEqual(query('scopeViewport()')(null, query(gcEvents.context)(null, parent)), { start: 0, end: 100 });
    assert.deepEqual(query('scopeViewport()')(null, query(timeCharts.context)(null, parent)), { start: 0, end: 100 });
    assert.deepEqual([
        gcEvents.zoom,
        findView(chartUsedHeap, { view: 'cpupro-chart' }).zoom,
        findView(userTimingsTimeline, { view: 'track-timeline' }).zoom
    ], [true, true, true]);
});

test('GC events and user timings are intervals and spans of the profile thread', () => {
    const thread = {
        events: [
            { name: 'MinorGC', tm: 1, duration: 2 },
            { name: 'Other', tm: 2, duration: 1 },
            { name: 'MajorGC', tm: 4, duration: 3 }
        ],
        userTimings: [
            { name: 'measure', tm: 5, duration: 10 },
            { name: 'before', tm: -1, duration: 2 },
            { name: 'start', tm: 0, duration: 3 }
        ]
    };
    const context = { scopeProfile: { thread } };
    const { spans, intervals } = query(userTimingsTimeline.data)(null, context);

    assert.deepEqual(query(gcEvents.data)(null, context), [
        { start: 1, end: 3, color: '#f7b26b38' },
        { start: 4, end: 7, color: '#f78c6b38' }
    ]);
    assert.deepEqual(spans, [
        { start: 5, end: 15, text: 'measure', event: thread.userTimings[0] },
        { start: 0, end: 3, text: 'start', event: thread.userTimings[2] }
    ]);
    assert.deepEqual(intervals, [
        { start: 1, end: 3, name: 'MinorGC', color: '#f7b26b38' },
        { start: 4, end: 7, name: 'MajorGC', color: '#f78c6b38' },
        { offset: 0, name: 'Timeline', color: '#6666' },
        { offset: 500000, name: 'Timeline', color: '#6666' }
    ]);
});

test.each([
    ['in the timeline', { spanStart: 3, spanEnd: 13 }, [10, 3, 13]],
    ['before the timeline', { spanStart: -2, spanEnd: 0 }, [10, 0, 0]]
])('user timing tooltips show the duration and the position of a span %s', (_, context, values) => {
    const tooltip = findView(userTimingsTimeline, { view: 'labeled-value-list', kind: 'inline-grid' });

    assert.deepEqual(query(tooltip.data)({ start: 5, end: 15 }, context).map(row => [row.text, row.value]), [
        ['Duration', values[0]],
        ['Start', values[1]],
        ['End', values[2]]
    ]);
});

test.each(['timeline', 'memline'])('time charts keep the timeline, its viewport and selection with the %s as the primary line', async primaryLineType => {
    const { profile, line: timeLine } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const { line: memline } = await createLineFixture({ type: 'memline', values: new Uint32Array([1000]) });
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const usedHeap = chartUsedHeap.content;
    const chart = findView(usedHeap, { view: 'cpupro-chart' });
    const selectedLine = { timeline: timeLine, memline }[primaryLineType];

    memline.profile = profile;
    profile.memline = memline as typeof profile.memline;
    profile.lines.push(memline);
    memline.range.setRange(2, 5);

    const memorySelection = memline.range.selection.ranges;
    const parent = {
        ...pageContext(profile, [other.profile, profile]),
        primaryLineType,
        scopeLine: selectedLine,
        scopeBreakdown: { line: selectedLine }
    };
    const context = query(timeCharts.context)(null, lineMetricsValueContext(timeline, profile, parent, query));
    const data = query(usedHeap.data)(null, context);

    assert.deepEqual([...timeCharts.content], [chartUsedHeap, userTimingsTimeline]);
    assert.deepEqual([context.scopeLine, context.scopeBreakdown, query('scopeViewport()')(null, context)], [timeLine, null, { start: 100, end: 200 }]);
    assert.deepEqual(data.extent, { start: 120, end: 180 });
    assert.deepEqual([chart.extent, chart.minX, chart.maxX].map(prop => propQuery(prop)(data, context)), [data.extent, 100, 200]);
    assert.deepEqual(query('scopeViewport()')(query(userTimingsTimeline.data)(null, context), context), { start: 100, end: 200 });

    query('scopeLine()')(null, context).range.selection.setRange(130, 140);

    assert.deepEqual(timeLine.range.ranges, [{ start: 10, end: 20 }]);
    assert.equal(memline.range.selection.ranges, memorySelection);
});
