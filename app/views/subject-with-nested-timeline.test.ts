import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';

const definition = runInNewContext(readFileSync(new URL('./subject-with-nested-timeline.js', import.meta.url), 'utf8'), {
    discovery: { view: { define: (_: string, config: unknown) => config } },
    require: () => ({ resolveScopeProfileLine, resolveScopeViewport })
});
const query = jora.setup({ methods: { ...methods, marker: () => ({ type: 'category' }) } });

test('matches the default page category bins under the computed common viewport', async () => {
    const timeline = runInNewContext(readFileSync(new URL('../pages/default.js', import.meta.url), 'utf8') + '\ncategoriesTimeline;', {
        require: () => ({ supportedFormats: [], sessionExpandState: () => ({}) }),
        discovery: { nav: { primary: { append() {} } }, page: { define() {} } }
    });
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const context = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, { timeline: { axisStart: -100, axisEnd: 900 } }] }
    };
    const panelContext = query(timeline.context)(profile, context);
    const panel = query(timeline.data)(profile, panelContext);
    const row = panel.samples.find((entry: { category: { name: string } }) => entry.category.name === 'script');
    const tree = profile.timeline!.breakdowns[0].categories!.all.nodes;
    const data = query(definition.data)({ subject: row.category, tree }, context);

    assert.equal(data.duration, 1000);
    assert.equal(data.binCount, 500);
    assert.equal(data.binSize, row.binSize);
    assert.deepEqual(data.bins, row.bins);
    assert.deepEqual(data.totalValueBins, row.totalValueBins);
    assert.deepEqual(data.binSamples, row.binSamples);
    assert.equal(definition.content[2].content.view, 'line-histogram');
    assert.equal(definition.content[3].content.view, 'line-histogram');
    assert.equal(definition.content[4].item.view, 'line-histogram');
});

test('inherits the viewport for bins, ruler and selection without changing totals or the parent context', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const breakdown = line.breakdowns[0];
    const tree = breakdown.categories!.all.nodes;
    const subject = tree.tree.dictionary.find(entry => entry.name === 'script')!;
    const input = { subject, tree };
    const baseContext = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile] } };
    assert.equal(definition.context, undefined);

    for (const scopeViewport of [{ start: -10, end: 90 }, { start: 15, end: 25 }]) {
        const context = { ...baseContext, scopeViewport };
        const data = query(definition.data)(input, context);
        const duration = scopeViewport.end - scopeViewport.start;
        const ruler = definition.content[0];
        assert.equal(data.duration, duration);
        assert.equal(data.binCount, duration);
        assert.equal(data.totalValue, line.axisTotal);
        assert.equal(data.bins.length, data.binCount);
        assert.equal(query(ruler.range.slice(1))(data, context), scopeViewport);
        assert.equal(query('scopeViewport()')(data, context), scopeViewport);
        const range = query(ruler.rangeManager.slice(1))(data, context);
        assert.equal(range, line.range.selection);
        range.setRange(scopeViewport.start + 1, scopeViewport.start + 5);
        assert.deepEqual(line.range.selection.ranges, [{ start: scopeViewport.start + 1, end: scopeViewport.start + 5 }]);
        if (scopeViewport.start < 0) {
            assert.ok(data.bins.slice(0, 20).every((value: number) => value === 0));
            assert.ok(data.bins.slice(50).every((value: number) => value === 0));
        }
    }
});

test('places code ticks and writes their selection in the recording coordinate space', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const context = { primaryProfile: profile, primaryLineType: 'timeline', scopeViewport: { start: -10, end: 90 } };
    const styles = new Map();
    const listeners = new Map();
    const element = {
        style: { setProperty: (name: string, value: unknown) => styles.set(name, value) },
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback)
    };
    definition.content[1].itemConfig.postRender(element, {}, { tm: 20, duration: 10, color: '1,2,3,1' }, context);
    assert.equal(styles.get('--pos'), 0.3);
    assert.equal(styles.get('--duration'), 0.1);
    listeners.get('click')();
    assert.deepEqual(profile.timeline!.range.selection.ranges, [{ start: 20, end: 30 }]);
});
