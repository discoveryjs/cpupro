import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { createProfile } from '../prepare/profile.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { findContent, findView, lineMetricsValueContext } from '../../test/helpers/view-config.js';
import * as lineWindow from './misc/line-window.js';

const definition = evaluateModule(new URL('./subject-with-nested-timeline.js', import.meta.url), {
    discovery: { view: { define: (_: string, config: unknown) => config } },
    require: () => ({ resolveScopeProfileLine, ...lineWindow })
});

// Subjects are categories or call frames
const callFrameMarker = (_: unknown, type: string) => {
    if (type === 'category') {
        return null;
    }

    return { type: 'call-frame' };
};
const categoryQuery = jora.setup({ methods: { ...methods, marker: () => ({ type: 'category' }) } });
const callFrameQuery = jora.setup({ methods: { ...methods, marker: callFrameMarker } });
const propQuery = (value: string) => categoryQuery(value.slice(1));
const contentQuery = (content: string) => categoryQuery(content.slice(content.indexOf(':') + 1));

const subjectBins = definition.content;
const ruler = findView(subjectBins, { view: 'line-ruler' });
const ticks = findView(subjectBins, { view: 'line-intervals' });
const selfTime = findView(findView(subjectBins, { className: 'self-time' }), { view: 'line-histogram' });
const nestedTime = findView(findView(subjectBins, { className: 'nested-time' }), { view: 'line-histogram' });
const nestedWork = findView(subjectBins, { className: 'nested-work' });
const nestedWorkHistogram = findView(nestedWork, { view: 'line-histogram' });

// The context of a page showing the timeline of its primary profile among the profiles
function pageContext(profile: unknown, profiles = [profile]) {
    return {
        primaryProfile: profile,
        primaryLineType: 'timeline',
        data: { profiles }
    };
}

function profileCallFrame(functionName: string, url: string, scriptId: number) {
    const position = scriptId ? 0 : -1;

    return {
        functionName,
        url,
        scriptId,
        lineNumber: position,
        columnNumber: position
    };
}

// A timeline of 50 units sampling `run` (a script) twice, its callees `helper` (a script) and `extension`
// (a chrome extension), and `(idle)` outside of it
async function createNestedProfile() {
    const main = 'https://example.org/main.js';
    const extension = 'chrome-extension://fixture/main.js';
    const profile = await createProfile({
        startTime: 0,
        endTime: 50,
        nodes: [
            {
                id: 1,
                callFrame: profileCallFrame('(root)', '', 0),
                children: [2, 5]
            },
            {
                id: 2,
                callFrame: profileCallFrame('run', main, 1),
                children: [3, 4]
            },
            {
                id: 3,
                callFrame: profileCallFrame('helper', main, 1)
            },
            {
                id: 4,
                callFrame: profileCallFrame('extension', extension, 2)
            },
            {
                id: 5,
                callFrame: profileCallFrame('(idle)', '', 0)
            }
        ],
        samples: [2, 3, 2, 4, 5],
        timeDeltas: [10, 10, 10, 10, 10]
    });
    const breakdown = profile.timeline!.breakdowns[0];

    return {
        profile,
        context: pageContext(profile),
        callFrames: breakdown.callFrames!.all.nodes,
        categories: breakdown.categories!.all.nodes
    };
}

test.each([
    ['the viewport bounds', null, { start: 0, end: 40 }, 40],
    ['a viewport', [{ start: 15, end: 25 }], { start: 15, end: 25 }, 10]
])('the subject bins the line window of %s and follows its population', async (_, viewport, window, binCount) => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const tree = line.breakdowns[0].categories!.all.nodes;
    const input = {
        subject: tree.tree.dictionary.find(entry => entry.name === 'script'),
        tree
    };
    const parent = pageContext(profile);

    line.viewport.selection.setRanges(viewport);

    const context = lineMetricsValueContext(definition, input, parent, categoryQuery);
    const data = categoryQuery(definition.data)(input, context);
    const { value } = lineMetricsValueContext(subjectBins, data, context, categoryQuery).subjectBins;

    assert.equal(propQuery(definition.metrics)(input, parent), line.breakdowns[0].populationWindow);
    assert.deepEqual(context.lineWindow.value, {
        ...parent,
        scopeViewport: window,
        binCount
    });
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

test('category subject bins match the default page category bins over a viewport common to all profiles', async () => {
    const page = evaluateModule(new URL('../pages/default.js', import.meta.url), {
        require: () => ({
            supportedFormats: [],
            sessionExpandState: () => ({}),
            ...lineWindow
        }),
        discovery: { nav: { primary: { append() {} } }, page: { define() {} } }
    }, 'categoriesTimelineWindow');
    const { profile, categories } = await createNestedProfile();
    const parent = pageContext(profile, [profile, { timeline: { axisStart: -100, axisEnd: 900 } }]);
    const pageWindowContext = lineMetricsValueContext(page, profile, parent, categoryQuery);
    const panel = categoryQuery(page.data)(profile, pageWindowContext);
    const pageBins = findView(page, { name: 'categoryBins' });
    const pageBinsContext = lineMetricsValueContext(pageBins, panel, pageWindowContext, categoryQuery);
    const pageHistogram = findView(pageBins, { view: 'line-histogram' });
    const category = panel.samples.find(row => row.category.name === 'script');
    const pageRow = categoryQuery(pageHistogram.data)(category, pageBinsContext);
    const input = { subject: category.category, tree: categories };
    const context = lineMetricsValueContext(definition, input, parent, categoryQuery);
    const data = categoryQuery(definition.data)(input, context);
    const { value } = lineMetricsValueContext(subjectBins, data, context, categoryQuery).subjectBins;
    const nestedPresence = value.totalValueBins.map(bin => bin > 0 ? 1 : 0);

    assert.deepEqual(context.lineWindow.value.scopeViewport, { start: -100, end: 900 });
    assert.equal(context.lineWindow.value.binCount, pageWindowContext.lineWindow.value.binCount);
    assert.equal(value.binSize, pageRow.binSize);
    assert.deepEqual(Array.from(value.bins), Array.from(pageRow.bins));
    assert.deepEqual(nestedPresence, Array.from(pageRow.nestedPresence));
    assert.deepEqual(data.nested.map(nested => nested.category.name), ['chrome-extension']);
});

test('nested work of a subject is its callees by category in category order, binned within its subtree', async () => {
    const { profile, context: parent, callFrames } = await createNestedProfile();
    const input = {
        subject: callFrames.tree.dictionary.find(entry => entry.name === 'run'),
        tree: callFrames
    };
    const context = lineMetricsValueContext(definition, input, parent, callFrameQuery);
    const data = callFrameQuery(definition.data)(input, context);
    const binsContext = lineMetricsValueContext(subjectBins, data, context, callFrameQuery);
    const { value } = binsContext.subjectBins;
    const binsTotal = (bins: ArrayLike<number>) => Array.from(bins).reduce((sum, bin) => sum + bin, 0);
    const nestedWorkBins = categoryQuery(nestedWorkHistogram.data);

    assert.deepEqual(data.nested.map(nested => [nested.category.name, nested.color]), [
        ['script', methods.color('script')],
        ['chrome-extension', methods.color('chrome-extension')]
    ]);
    assert.equal(data.profile, profile);
    assert.deepEqual([binsTotal(value.bins), binsTotal(value.totalValueBins)], [20, 20]);
    assert.deepEqual(value.nested.map(nested => [nested.category.name, binsTotal(nested.bins)]), [
        ['script', 10],
        ['chrome-extension', 10]
    ]);
    assert.equal(propQuery(nestedTime.color)(data), data.color);
    assert.equal(categoryQuery(nestedWork.whenData)(data.nested), true);
    assert.deepEqual(data.nested.map(nested => nestedWorkBins(nested, binsContext)), value.nested);
    assert.deepEqual(categoryQuery(selfTime.data)(data, binsContext).bins, value.bins);
});

test('a subject with a single nested category shows its color as nested time and no nested work', () => {
    const data = {
        color: 'subject',
        nested: [{ category: { name: 'gc' }, color: 'nested' }]
    };

    assert.equal(propQuery(nestedTime.color)(data), 'nested');
    assert.equal(categoryQuery(nestedWork.whenData)(data.nested), false);
});

test('ruler details sum the bins of the selected segments', () => {
    const details = ruler.details;
    const list = findView(details, { className: 'category-timings-list' });
    const value = {
        binSamples: [1, 0, 2, 5],
        bins: [0, 3, 1, 2],
        totalValueBins: [2, 4, 1, 3]
    };
    const data = categoryQuery(details.data)({ totalValue: 100 }, { subjectBins: { value } });
    const context = {
        segmentStart: 1,
        segmentEnd: 2,
        timeStart: 10,
        timeEnd: 30,
        resolution: 2
    };
    const content = (prefix: string) => contentQuery(findContent(details, prefix))(data, context);
    const className = propQuery(list.itemConfig.className);

    assert.equal(content('text:`Samples:'), 'Samples: 2');
    assert.deepEqual(content('metric:{ value:'), { value: 20, total: 100, resolution: 2 });
    assert.deepEqual(content('metric:{ metricName: "selfValue"'), {
        metricName: 'selfValue',
        value: 4,
        total: 100,
        resolution: 2
    });
    assert.deepEqual(content('metric:{ metricName: "nestedValue"'), {
        metricName: 'nestedValue',
        value: 5,
        total: 100,
        resolution: 2
    });
    assert.equal(className({ bins: [1, 0, 0, 1] }, context), 'no-time');
    assert.equal(className({ bins: [0, 1, 0, 0] }, context), undefined);
});

test('code ticks of a call frame are placed in recording coordinates, rounded to bins of the window', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const callFrame = { name: 'fn' };
    const segments = [{ tm: 40, duration: 5 }, { tm: 60, duration: 2 }];
    const codes = [
        { tm: 20, duration: 10, tier: 'Ignition', callFrame },
        { tm: 40, tier: 'Maglev', callFrame, segments }
    ];
    const codesByCallFrame = [
        { callFrame: { name: 'other' }, codes: [] },
        { callFrame, codes }
    ];
    const context = {
        primaryProfile: profile,
        primaryLineType: 'timeline',
        scopeViewport: { start: -10, end: 90 },
        binCount: 100
    };
    const intervals = callFrameQuery(ticks.data)({
        subject: callFrame,
        scopeLine: { axisStart: 1000 },
        profile: { timeline: { axisTotal: 100 }, codesByCallFrame }
    }, context);
    const tick = (interval: Record<string, unknown>) => [interval.start, interval.end, interval.segment, interval.code];
    const shown = callFrameQuery(ticks.when);
    // Ends of ticks are rounded to bins of the window, they are rendered again in its context
    const update = findView(subjectBins, { view: 'update-on-line-metrics-changes', metrics: '=#.lineWindow' });
    const windowContext = findView(update, { view: 'context' });

    assert.equal(propQuery(update.metrics)(null, { lineWindow: 'window' }), 'window');
    assert.equal(categoryQuery(windowContext.context)(null, { lineWindow: { value: context } }), context);
    assert.equal(ticks.zoom, true);
    assert.equal(shown({ scopeLine: { type: 'timeline' } }), true);
    assert.equal(shown({ scopeLine: { type: 'memline' } }), false);
    assert.deepEqual(intervals.map(tick), [
        [1020, 1030, { tm: 20, duration: 10 }, codes[0]],
        [1040, 1045, segments[0], codes[1]],
        [1060, 1062, segments[1], codes[1]]
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
    const codes = [{ tm, duration, tier: 'Ignition', callFrame }];
    const [interval] = ticksQuery(ticks.data)({
        subject: callFrame,
        scopeLine: { axisStart: 0 },
        profile: {
            timeline: { axisTotal: 100 },
            codesByCallFrame: [{ callFrame, codes }]
        }
    }, { scopeViewport: { start: -10, end: 90 }, binCount: 20 });

    assert.deepEqual([interval.start, interval.end], [tm, tm + expected]);
});

test('code ticks of a module are the codes of its script compilation', () => {
    const moduleQuery = jora.setup({ methods: { ...methods, marker: () => ({ type: 'module' }) } });
    const script = { id: 1 };
    const codesByScript = [
        {
            script: { id: 2 },
            compilation: { codes: [{ tm: 1, duration: 1, tier: 'Ignition' }] }
        },
        {
            script,
            compilation: { codes: [{ tm: 5, duration: 2, tier: 'Sparkplug' }] }
        }
    ];
    const intervals = moduleQuery(ticks.data)({
        subject: { script },
        scopeLine: { axisStart: 100 },
        profile: { timeline: { axisTotal: 100 }, codesByScript }
    }, { scopeViewport: { start: 0, end: 100 }, binCount: 100 });

    assert.deepEqual(intervals.map(interval => [interval.start, interval.end]), [[105, 107]]);
});

test('code tick tooltips number the segments of a code', () => {
    const segments = findView(ticks.itemConfig.tooltip, { view: 'block' });
    const first = { tm: 40, duration: 5 };
    const second = { tm: 60, duration: 2 };
    const shown = callFrameQuery(segments.when);
    const label = contentQuery(findContent(segments, 'text:`Segment '));

    assert.equal(shown({ code: { segments: [first, second] } }), true);
    assert.equal(shown({ code: { segments: [first] } }), false);
    assert.equal(label({ code: { segments: [first, second] }, segment: second }), 'Segment 2 of 2');
});

test('code ticks are colored by their tier and select their range of the line on click', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const styles = new Map();
    const listeners = new Map();
    const element = {
        style: {
            setProperty: (name: string, value: unknown) => styles.set(name, value)
        },
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback)
    };

    ticks.itemConfig.postRender(
        element,
        {},
        { start: 20, end: 30, tierColor: '1,2,3' },
        { primaryProfile: profile, primaryLineType: 'timeline' }
    );
    listeners.get('click')();

    assert.equal(styles.get('--tier-color'), 'rgb(1,2,3, .68)');
    assert.deepEqual(profile.timeline!.range.selection.ranges, [{ start: 20, end: 30 }]);
});
