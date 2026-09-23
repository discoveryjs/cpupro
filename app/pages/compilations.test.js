import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';

let page;
vi.stubGlobal('discovery', { page: { define(name, config) {
    assert.equal(name, 'compilations');
    page = config;
} } });
await import('./compilations.js');
vi.unstubAllGlobals();

const query = jora.setup({ methods });
const table = page.content.content.content[1].content;
const rows = query(table.data);
const contextFor = (profile, kind = 'location') => query(page.content.context)(null, {
    primaryProfile: profile, primaryLineType: 'timeline', primaryBreakdownKind: kind
});

test.each(['call-stack', 'location'])('shows event time without memory data with %s selected', async kind => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const frame = profile.callFrames.find(frame => frame.name === 'first');
    profile.thread = { events: [{
        cat: 'disabled-by-default-v8.compilation_allocations', name: 'Parse', callFrame: frame, selfTime: 30
    }] };
    const context = contextFor(profile, kind);
    assert.equal(context.allocationPopulation, undefined);
    assert.deepEqual(rows(null, context), [{ callFrame: frame, events: 1, selfTime: 30, count: 0, size: 0 }]);
});

test('uses the selected memory breakdown, combines raw owners and follows stage and range changes', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline;
    const first = profile.callFrames.find(frame => frame.name === 'first');
    const second = profile.callFrames.find(frame => frame.name === 'second');
    line.attributes.push(
        { name: 'allocationOwner', dict: [null, first, second, first], values: new Uint32Array([1, 2, 3, 0]) },
        { name: 'allocationCompilationStage', dict: ['none', 'Compile', 'Parse'], values: new Uint8Array([1, 1, 1, 0]) }
    );
    profile.thread = { events: [
        { name: 'Compile', callFrame: first, selfTime: 50 },
        { name: 'Parse', callFrame: first, selfTime: 30 },
        { name: 'Parse', callFrame: first, selfTime: 30 },
        { name: 'Compile', callFrame: second, selfTime: 20 }
    ].map(event => ({ ...event, cat: 'disabled-by-default-v8.compilation_allocations' })) };
    const stop = prepareLineFilters(line);
    try {
        const context = contextFor(profile);
        const population = line.breakdowns.find(breakdown => breakdown.kind === 'location').populationFiltered;
        assert.equal(context.allocationPopulation, population);
        assert.deepEqual(rows(null, context).map(row => [row.count, row.size, row.selfTime]), [[2, 64, 110], [1, 32, 20]]);
        const other = contextFor(profile, 'call-stack');
        other.allocationPopulation.updateMask(mask => mask.fill(0x80000000));
        assert.equal(rows(null, other).reduce((total, row) => total + row.size, 0), 0);
        assert.equal(rows(null, context).reduce((total, row) => total + row.size, 0), 96);
        const stages = line.filters.get('allocationCompilationStage');
        const controls = page.modifiers[0].content[2].content.content;
        const filterContext = query(controls.context)(profile, context);
        const filterData = query(controls.data)(profile, filterContext);
        assert.equal(filterData, stages);
        const options = query(controls.content[0].data)(filterData, filterContext);
        const checkbox = controls.content[0].item;
        assert.deepEqual(options.map(option => option.key), ['Compile', 'Parse']);
        assert.ok(options.every(option => query(checkbox.checked.slice(1))(option, filterContext)));
        query(checkbox.onChange.slice(1))(options[0], filterContext)(false);
        assert.deepEqual(rows(null, context).map(row => [row.size, row.selfTime]), [[0, 60]]);
        query(controls.content[1].onClick.slice(1))(filterData, filterContext)();
        population.setRanges([{ start: 5, end: 10 }]);
        assert.deepEqual(rows(null, context).map(row => [row.size, row.selfTime]), [[5, 110], [0, 20]]);
        population.setRanges([{ start: 0, end: 16 }, { start: 48, end: 64 }]);
        assert.deepEqual(rows(null, context).map(row => [row.count, row.size]), [[2, 32], [0, 0]]);
        const filterSubscription = page.content.content.content[0].content;
        const populationSubscription = filterSubscription.content.content[0].content;
        assert.equal(query(filterSubscription.metrics.slice(1))(null, context), line.filters);
        assert.equal(query(populationSubscription.metrics.slice(1))(null, context), population);
        assert.equal(page.modifiers[0].content[2].view, 'expand');
    } finally {
        stop();
    }
});
