import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

const definition = evaluateModule(new URL('./subject-with-nested-timeline.js', import.meta.url), {
    discovery: { view: { define: (_: string, config: unknown) => config } },
    require: () => ({ resolveScopeProfileLine })
});
const query = jora.setup({ methods: { ...methods, marker: () => ({ type: 'category' }) } });

const view = definition.content;

test('matches the default page category bins under the computed common viewport', async () => {
    const timeline = evaluateModule(new URL('../pages/default.js', import.meta.url), {
        require: () => ({ supportedFormats: [], sessionExpandState: () => ({}) }),
        discovery: { nav: { primary: { append() {} } }, page: { define() {} } }
    }, 'categoriesTimelineWindow');
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const context = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, { timeline: { axisStart: -100, axisEnd: 900 } }] }
    };
    const panelContext = query(timeline.context)(profile, context);
    const panel = query(timeline.data)(profile, panelContext);
    const row = panel.samples.find((entry: { category: { name: string } }) => entry.category.name === 'script');
    const tree = profile.timeline!.breakdowns[0].categories!.all.nodes;
    const input = { subject: row.category, tree };
    const data = query(view.data)(input, query(view.context)(input, context));

    assert.equal(data.duration, 1000);
    assert.equal(data.binCount, panelContext.binCount);
    assert.equal(data.binSize, row.binSize);
    assert.deepEqual(Array.from(data.bins), Array.from(row.bins));
    assert.deepEqual(data.totalValueBins.map((value: number) => value > 0 ? 1 : 0), Array.from(row.nestedPresence));
    assert.equal(view.content[2].content.view, 'line-histogram');
    assert.equal(view.content[3].content.view, 'line-histogram');
    assert.equal(view.content[4].item.view, 'line-histogram');
});

test('computes bins for the line window, zooms the line viewport and re-renders on the window population', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const breakdown = line.breakdowns[0];
    const tree = breakdown.categories!.all.nodes;
    const subject = tree.tree.dictionary.find(entry => entry.name === 'script')!;
    const input = { subject, tree };
    const baseContext = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } };

    assert.equal(definition.view, 'update-on-line-metrics-changes');
    assert.equal(query(definition.metrics.slice(1))(input, baseContext), breakdown.populationWindow);

    for (const viewport of [null, { start: 15, end: 25 }]) {
        if (viewport) {
            line.viewport.selection.setRange(viewport.start, viewport.end);
        }

        const context = query(view.context)(input, baseContext);
        const window = methods.lineWindow(line, baseContext.data.profiles);
        const data = query(view.data)(input, context);
        const ruler = view.content[0];

        assert.deepEqual(context.scopeViewport, window);
        assert.equal(data.duration, window.end - window.start);
        assert.equal(data.binCount, Math.min(2000, Math.floor(window.end - window.start)));
        assert.equal(data.totalValue, line.axisTotal);
        assert.equal(data.bins.length, data.binCount);
        assert.equal(query(ruler.range.slice(1))(data, context), context.scopeViewport);
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
    const ticks = view.content[1];
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
