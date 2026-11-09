import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import * as lineWindow from './misc/line-window.js';

const definition = evaluateModule(new URL('./subject-with-nested-timeline.js', import.meta.url), {
    discovery: { view: { define: (_: string, config: unknown) => config } },
    require: () => ({ resolveScopeProfileLine, ...lineWindow })
});
const query = jora.setup({ methods: { ...methods, marker: () => ({ type: 'category' }) } });

// Bins of the subject are a value of the line window, views of the timeline read it
const subjectBins = definition.content;
const view = subjectBins.content;
// The context of the line window and a value computed for it, as they are provided by `line-metrics-value`
const windowContext = (config: { value: string }, data: unknown, parent: object) => {
    const value = query(config.value)(data, parent);

    return { ...value, lineWindow: { value } };
};
const windowValue = (config: { valueContext: string, value: string }, data: unknown, context: object) =>
    query(config.value)(data, query(config.valueContext)(data, context));

test('matches the default page category bins under the computed common viewport', async () => {
    const timeline = evaluateModule(new URL('../pages/default.js', import.meta.url), {
        require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), ...lineWindow }),
        discovery: { nav: { primary: { append() {} } }, page: { define() {} } }
    }, 'categoriesTimelineWindow');
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const context = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, { timeline: { axisStart: -100, axisEnd: 900 } }] }
    };
    const panelContext = windowContext(timeline, profile, context);
    const panel = query(timeline.data)(profile, panelContext);
    const categoryBins = timeline.content.find((entry: { name?: string }) => entry?.name === 'viewportCategories').content;
    const categoryHistogram = categoryBins.content.item.content.at(-1).content;
    const category = panel.samples.find((entry: { category: { name: string } }) => entry.category.name === 'script');
    const row = query(categoryHistogram.data)(category, { ...panelContext, categoryBins: { value: windowValue(categoryBins, panel, panelContext) } });
    const tree = profile.timeline!.breakdowns[0].categories!.all.nodes;
    const input = { subject: category.category, tree };
    const subjectContext = windowContext(definition, input, context);
    const data = query(definition.data)(input, subjectContext);
    const bins = windowValue(subjectBins, data, subjectContext);

    assert.equal(subjectContext.scopeViewport.end - subjectContext.scopeViewport.start, 1000);
    assert.equal(subjectContext.binCount, panelContext.binCount);
    assert.equal(bins.binSize, row.binSize);
    assert.deepEqual(Array.from(bins.bins), Array.from(row.bins));
    assert.deepEqual(bins.totalValueBins.map((value: number) => value > 0 ? 1 : 0), Array.from(row.nestedPresence));

    // Histograms are the parts rendered again when the bins change
    for (const histogram of [view[2].content, view[3].content, view[4].item]) {
        assert.equal(histogram.view, 'update-on-line-metrics-changes');
        assert.equal(histogram.metrics, '=#.subjectBins');
        assert.equal(histogram.content.view, 'line-histogram');
    }

    const histogramContext = { ...subjectContext, subjectBins: { value: bins } };
    assert.equal(query(view[2].content.content.data)(data, histogramContext).bins, bins.bins);
    assert.deepEqual(
        query(view[4].data)(data, histogramContext).map((nested: object) => query(view[4].item.content.data)(nested, histogramContext)),
        bins.nested
    );
});

test('computes bins for the line window, zooms the line viewport and re-renders on the window population', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const breakdown = line.breakdowns[0];
    const tree = breakdown.categories!.all.nodes;
    const subject = tree.tree.dictionary.find(entry => entry.name === 'script')!;
    const input = { subject, tree };
    const baseContext = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } };

    assert.equal(definition.view, 'line-metrics-value');
    assert.equal(definition.name, 'lineWindow');
    assert.equal(query(definition.metrics.slice(1))(input, baseContext), breakdown.populationWindow);
    assert.equal(subjectBins.metrics, '=#.lineWindow');

    for (const viewport of [null, { start: 15, end: 25 }]) {
        if (viewport) {
            line.viewport.selection.setRange(viewport.start, viewport.end);
        }

        const context = windowContext(definition, input, baseContext);
        const window = methods.lineWindow(line, baseContext.data.profiles);
        const data = query(definition.data)(input, context);
        const bins = windowValue(subjectBins, data, context);
        const ruler = view[0];

        assert.deepEqual(context.scopeViewport, window);
        assert.equal(context.binCount, Math.min(2000, Math.floor(window.end - window.start)));
        assert.equal(bins.binSize, (window.end - window.start) / context.binCount);
        assert.equal(data.totalValue, line.axisTotal);
        assert.equal(bins.bins.length, context.binCount);
        assert.equal(query(ruler.window.slice(1))(data, context), context.lineWindow);
        assert.equal(ruler.zoom, true);
        const range = query(ruler.rangeManager.slice(1))(data, context);
        assert.equal(range, line.range.selection);
        range.setRange(window.start + 1, window.start + 5);
        assert.deepEqual(line.range.selection.ranges, [{ start: window.start + 1, end: window.start + 5 }]);
        range.resetRange();
    }

    line.viewport.resetRange();
});

test('places code ticks in the recording coordinate space and writes their selection', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const context = { primaryProfile: profile, primaryLineType: 'timeline', scopeViewport: { start: -10, end: 90 }, binCount: 100 };
    const ticksPart = view[1];
    const ticks = ticksPart.content.content;

    // Ends of ticks are rounded to bins of the window, they are rendered again in its context
    assert.equal(ticksPart.view, 'update-on-line-metrics-changes');
    assert.equal(ticksPart.metrics, '=#.lineWindow');
    assert.equal(ticksPart.content.context, '#.lineWindow.value');
    const callFrame = { name: 'fn' };
    const codes = [
        { tm: 20, duration: 10, tier: 'Ignition', callFrame },
        { tm: 40, tier: 'Maglev', callFrame, segments: [{ tm: 40, duration: 5 }, { tm: 60, duration: 2 }] }
    ];
    const frameQuery = jora.setup({ methods: { ...methods, marker: () => ({ type: 'call-frame' }) } });
    const intervals = frameQuery(ticks.data)({
        subject: callFrame,
        scopeLine: { axisStart: 1000 },
        profile: { timeline: { axisTotal: 100 }, codesByCallFrame: [{ callFrame, codes }] }
    }, context);

    assert.equal(ticks.view, 'line-intervals');
    assert.equal(ticks.zoom, true);
    assert.deepEqual(intervals.map(({ start, end, segment }) => ({ start, end, segment })), [
        { start: 1020, end: 1030, segment: { tm: 20, duration: 10 } },
        { start: 1040, end: 1045, segment: codes[1].segments![0] },
        { start: 1060, end: 1062, segment: codes[1].segments![1] }
    ]);
    assert.ok(intervals.every((interval: object) => !('color' in interval)));

    const styles = new Map();
    const listeners = new Map();
    const element = {
        style: { setProperty: (name: string, value: unknown) => styles.set(name, value) },
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback)
    };

    ticks.itemConfig.postRender(element, {}, { start: 20, end: 30, tierColor: '1,2,3' }, context);
    assert.equal(styles.get('--tier-color'), 'rgb(1,2,3, .68)');
    listeners.get('click')();
    assert.deepEqual(profile.timeline!.range.selection.ranges, [{ start: 20, end: 30 }]);
});
