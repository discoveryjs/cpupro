import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { createProfile } from '../prepare/profile.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { findView, findViews, lineMetricsValueContext } from '../../test/helpers/view-config.js';
import * as lineWindow from './misc/line-window.js';

const definition = evaluateModule(new URL('./subject-with-nested-timeline.js', import.meta.url), {
    discovery: { view: { define: (_: string, config: unknown) => config } },
    require: () => ({ resolveScopeProfileLine, ...lineWindow })
});
// Subjects are categories or call frames
const categoryQuery = jora.setup({ methods: { ...methods, marker: () => ({ type: 'category' }) } });
const callFrameQuery = jora.setup({ methods: { ...methods, marker: (_, type) => type === 'category' ? null : { type: 'call-frame' } } });
const propQuery = (value: string) => categoryQuery(value.slice(1));
const contentQuery = (content: string) => categoryQuery(content.slice(content.indexOf(':') + 1));

const subjectBins = definition.content;
const ruler = findView(subjectBins, { view: 'line-ruler' });
const ticks = findView(subjectBins, { view: 'line-intervals' });
const selfTime = findView(subjectBins, { className: 'self-time' });
const nestedTime = findView(subjectBins, { className: 'nested-time' });
const nestedWork = findView(subjectBins, { className: 'nested-work' });

// A timeline of 50 units sampling `run` (a script) twice, its callees `helper` (a script) and `extension`
// (a chrome extension), and `(idle)` outside of it
async function createNestedProfile() {
    const callFrame = (functionName: string, url: string, scriptId: number) => ({ functionName, url, scriptId, lineNumber: scriptId ? 0 : -1, columnNumber: scriptId ? 0 : -1 });
    const profile = await createProfile({
        startTime: 0,
        endTime: 50,
        nodes: [
            { id: 1, callFrame: callFrame('(root)', '', 0), children: [2, 5] },
            { id: 2, callFrame: callFrame('run', 'https://example.org/main.js', 1), children: [3, 4] },
            { id: 3, callFrame: callFrame('helper', 'https://example.org/main.js', 1) },
            { id: 4, callFrame: callFrame('extension', 'chrome-extension://fixture/main.js', 2) },
            { id: 5, callFrame: callFrame('(idle)', '', 0) }
        ],
        samples: [2, 3, 2, 4, 5],
        timeDeltas: [10, 10, 10, 10, 10]
    });
    const breakdown = profile.timeline!.breakdowns[0];

    return {
        profile,
        context: { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } },
        callFrames: breakdown.callFrames!.all.nodes,
        categories: breakdown.categories!.all.nodes
    };
}

test.each([
    ['the viewport bounds', null, { start: 0, end: 40 }, 40],
    ['a viewport', [{ start: 15, end: 25 }], { start: 15, end: 25 }, 10]
])('the subject timeline bins the line window of %s and re-renders on changes of its population', async (_, viewport, window, binCount) => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const tree = line.breakdowns[0].categories!.all.nodes;
    const input = { subject: tree.tree.dictionary.find(entry => entry.name === 'script'), tree };
    const parent = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } };

    line.viewport.selection.setRanges(viewport);

    const context = lineMetricsValueContext(definition, input, parent, categoryQuery);
    const data = categoryQuery(definition.data)(input, context);
    const { value } = lineMetricsValueContext(subjectBins, data, context, categoryQuery).subjectBins;

    assert.equal(propQuery(definition.metrics)(input, parent), line.breakdowns[0].populationWindow);
    assert.deepEqual(context.lineWindow.value, { ...parent, scopeViewport: window, binCount });
    assert.deepEqual([data.totalValue, value.binSize, value.bins.length], [30, 1, binCount]);
});

test('the ruler zooms the line window and selects ranges of the subject line', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const context = { lineWindow: { value: {} } };
    const selection = propQuery(ruler.rangeManager)({ scopeLine: line }, context);

    selection.setRange(11, 15);

    assert.equal(ruler.zoom, true);
    assert.equal(propQuery(ruler.window)(null, context), context.lineWindow);
    assert.equal(selection, line.range.selection);
    assert.deepEqual(line.range.selection.ranges, [{ start: 11, end: 15 }]);
});

test('category subject bins match the default page category bins over a viewport common with other profiles', async () => {
    const page = evaluateModule(new URL('../pages/default.js', import.meta.url), {
        require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), ...lineWindow }),
        discovery: { nav: { primary: { append() {} } }, page: { define() {} } }
    }, 'categoriesTimelineWindow');
    const { profile, categories } = await createNestedProfile();
    const parent = {
        primaryProfile: profile,
        primaryLineType: 'timeline',
        data: { profiles: [profile, { timeline: { axisStart: -100, axisEnd: 900 } }] }
    };
    const pageContext = lineMetricsValueContext(page, profile, parent, categoryQuery);
    const panel = categoryQuery(page.data)(profile, pageContext);
    const pageBins = findView(page, { name: 'categoryBins' });
    const pageHistogram = findView(pageBins, { view: 'line-histogram' });
    const category = panel.samples.find(row => row.category.name === 'script');
    const row = categoryQuery(pageHistogram.data)(category, lineMetricsValueContext(pageBins, panel, pageContext, categoryQuery));
    const input = { subject: category.category, tree: categories };
    const context = lineMetricsValueContext(definition, input, parent, categoryQuery);
    const data = categoryQuery(definition.data)(input, context);
    const { value } = lineMetricsValueContext(subjectBins, data, context, categoryQuery).subjectBins;

    assert.deepEqual([context.lineWindow.value.scopeViewport, context.lineWindow.value.binCount], [{ start: -100, end: 900 }, pageContext.lineWindow.value.binCount]);
    assert.equal(value.binSize, row.binSize);
    assert.deepEqual(Array.from(value.bins), Array.from(row.bins));
    assert.deepEqual(value.totalValueBins.map(nested => nested > 0 ? 1 : 0), Array.from(row.nestedPresence));
    assert.deepEqual(data.nested.map(nested => nested.category.name), ['chrome-extension']);
});

test('nested work of a subject is its callees by category in the order of categories, binned within its subtree', async () => {
    const { profile, context: parent, callFrames } = await createNestedProfile();
    const input = { subject: callFrames.tree.dictionary.find(entry => entry.name === 'run'), tree: callFrames };
    const context = lineMetricsValueContext(definition, input, parent, callFrameQuery);
    const data = callFrameQuery(definition.data)(input, context);
    const binsContext = lineMetricsValueContext(subjectBins, data, context, callFrameQuery);
    const { value } = binsContext.subjectBins;
    const binsTotal = (bins: ArrayLike<number>) => Array.from(bins).reduce((sum, bin) => sum + bin, 0);

    assert.deepEqual(data.nested.map(nested => [nested.category.name, nested.color]), [
        ['script', methods.color('script')],
        ['chrome-extension', methods.color('chrome-extension')]
    ]);
    assert.equal(data.profile, profile);
    assert.deepEqual([binsTotal(value.bins), binsTotal(value.totalValueBins)], [20, 20]);
    assert.deepEqual(value.nested.map(nested => [nested.category.name, binsTotal(nested.bins)]), [['script', 10], ['chrome-extension', 10]]);
    assert.equal(propQuery(findView(nestedTime, { view: 'line-histogram' }).color)(data), data.color);
    assert.equal(categoryQuery(nestedWork.whenData)(data.nested), true);
    assert.deepEqual(data.nested.map(nested => categoryQuery(nestedWork.item.content.data)(nested, binsContext)), value.nested);
    assert.deepEqual(categoryQuery(findView(selfTime, { view: 'line-histogram' }).data)(data, binsContext).bins, value.bins);
});

test('a subject with a single nested category shows its color as nested time and no nested work', () => {
    const data = { color: 'subject', nested: [{ category: { name: 'gc' }, color: 'nested' }] };

    assert.equal(propQuery(findView(nestedTime, { view: 'line-histogram' }).color)(data), 'nested');
    assert.equal(categoryQuery(nestedWork.whenData)(data.nested), false);
});

test('ruler details sum the bins of the selected segments', () => {
    const details = ruler.details;
    const [info, metrics] = findViews(details, { className: 'timeline-segment-info' });
    const [, samples, duration] = info.content;
    const [self, nested] = metrics.content;
    const list = findView(details, { className: 'category-timings-list' });
    const data = categoryQuery(details.data)({ totalValue: 100 }, { subjectBins: { value: {
        binSamples: [1, 0, 2, 5],
        bins: [0, 3, 1, 2],
        totalValueBins: [2, 4, 1, 3]
    } } });
    const context = { segmentStart: 1, segmentEnd: 2, timeStart: 10, timeEnd: 30, resolution: 2 };

    assert.equal(contentQuery(samples.content)(data, context), 'Samples: 2');
    assert.deepEqual(contentQuery(duration.content[1])(data, context), { value: 20, total: 100, resolution: 2 });
    assert.deepEqual(contentQuery(self.content)(data, context), { metricName: 'selfValue', value: 4, total: 100, resolution: 2 });
    assert.deepEqual(contentQuery(nested.content)(data, context), { metricName: 'nestedValue', value: 5, total: 100, resolution: 2 });
    assert.deepEqual([{ bins: [1, 0, 0, 1] }, { bins: [0, 1, 0, 0] }].map(row => propQuery(list.itemConfig.className)(row, context)), ['no-time', undefined]);
});

test('code ticks of a call frame are placed in the recording coordinate space, rounded to bins of the window', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const callFrame = { name: 'fn' };
    const codes = [
        { tm: 20, duration: 10, tier: 'Ignition', callFrame },
        { tm: 40, tier: 'Maglev', callFrame, segments: [{ tm: 40, duration: 5 }, { tm: 60, duration: 2 }] }
    ];
    const context = { primaryProfile: profile, primaryLineType: 'timeline', scopeViewport: { start: -10, end: 90 }, binCount: 100 };
    const intervals = callFrameQuery(ticks.data)({
        subject: callFrame,
        scopeLine: { axisStart: 1000 },
        profile: { timeline: { axisTotal: 100 }, codesByCallFrame: [{ callFrame: { name: 'other' }, codes: [] }, { callFrame, codes }] }
    }, context);
    // Ends of ticks are rounded to bins of the window, they are rendered again in its context
    const [update] = findViews(subjectBins, { view: 'update-on-line-metrics-changes', metrics: '=#.lineWindow' });

    assert.equal(propQuery(update.metrics)(null, { lineWindow: 'window' }), 'window');
    assert.equal(categoryQuery(update.content.context)(null, { lineWindow: { value: context } }), context);
    assert.equal(ticks.zoom, true);
    assert.deepEqual([callFrameQuery(ticks.when)({ scopeLine: { type: 'timeline' } }), callFrameQuery(ticks.when)({ scopeLine: { type: 'memline' } })], [true, false]);
    assert.deepEqual(intervals.map(({ start, end, segment, code }) => ({ start, end, segment, code })), [
        { start: 1020, end: 1030, segment: { tm: 20, duration: 10 }, code: codes[0] },
        { start: 1040, end: 1045, segment: codes[1].segments![0], code: codes[1] },
        { start: 1060, end: 1062, segment: codes[1].segments![1], code: codes[1] }
    ]);
});

// Bins of the window over -10..90 are of 5 units, a recording is of 100 units
test.each([
    ['its own duration', 40, 3, { lastSeen: 47 }, 3],
    ['the last sample of its call frame rounded up to a bin end', 40, undefined, { lastSeen: 47 }, 10],
    ['the recording end without later samples of its call frame', 41, undefined, { lastSeen: 41 }, 59],
    ['the recording end without samples of its call frame', 40, undefined, undefined, 60]
])('a code tick lasts %s', (_, tm, duration, bounds, expected) => {
    const callFrame = { name: 'fn' };
    const boundsByCallFrame = new WeakMap([[callFrame, bounds]]);
    const ticksQuery = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ type: 'call-frame' }),
            bounds: entry => boundsByCallFrame.get(entry)
        }
    });
    const [interval] = ticksQuery(ticks.data)({
        subject: callFrame,
        scopeLine: { axisStart: 0 },
        profile: { timeline: { axisTotal: 100 }, codesByCallFrame: [{ callFrame, codes: [{ tm, duration, tier: 'Ignition', callFrame }] }] }
    }, { scopeViewport: { start: -10, end: 90 }, binCount: 20 });

    assert.deepEqual([interval.start, interval.end], [tm, tm + expected]);
});

test('code ticks of a module are the codes of its script compilation', () => {
    const moduleQuery = jora.setup({ methods: { ...methods, marker: () => ({ type: 'module' }) } });
    const script = { id: 1 };
    const intervals = moduleQuery(ticks.data)({
        subject: { script },
        scopeLine: { axisStart: 100 },
        profile: {
            timeline: { axisTotal: 100 },
            codesByScript: [
                { script: { id: 2 }, compilation: { codes: [{ tm: 1, duration: 1, tier: 'Ignition' }] } },
                { script, compilation: { codes: [{ tm: 5, duration: 2, tier: 'Sparkplug' }] } }
            ]
        }
    }, { scopeViewport: { start: 0, end: 100 }, binCount: 100 });

    assert.deepEqual(intervals.map(({ start, end }) => [start, end]), [[105, 107]]);
});

test('code tick tooltips number the segments of a code', () => {
    const segments = findView(ticks.itemConfig.tooltip, { view: 'block' });
    const [first, second] = [{ tm: 40, duration: 5 }, { tm: 60, duration: 2 }];

    assert.deepEqual([
        callFrameQuery(segments.when)({ code: { segments: [first, second] } }),
        callFrameQuery(segments.when)({ code: { segments: [first] } })
    ], [true, false]);
    assert.equal(contentQuery(segments.content[0])({ code: { segments: [first, second] }, segment: second }), 'Segment 2 of 2');
});

test('code ticks are colored by their tier and select their range of the line on click', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const styles = new Map();
    const listeners = new Map();
    const element = {
        style: { setProperty: (name: string, value: unknown) => styles.set(name, value) },
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback)
    };

    ticks.itemConfig.postRender(element, {}, { start: 20, end: 30, tierColor: '1,2,3' }, { primaryProfile: profile, primaryLineType: 'timeline' });
    listeners.get('click')();

    assert.equal(styles.get('--tier-color'), 'rgb(1,2,3, .68)');
    assert.deepEqual(profile.timeline!.range.selection.ranges, [{ start: 20, end: 30 }]);
});
