import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { populationFilter } from './population-filter.js';
import { SetAttributeFilter, type FilterOption } from '../../prepare/computations/population-filter.js';
import type { ProfileLineBreakdown } from '../../prepare/lines/types.js';
import jora from 'jora';
import { methods, assertions } from '../../jora/index.mjs';

const query = jora.setup({ methods, assertions });
const list = populationFilter.content.content[0];
assert.ok(list.item);
const filterContext = list.item.context;
const controls = list.item.content.content;
const optionsList = controls[1];
assert.ok(typeof optionsList === 'object' && optionsList.item);
const checkbox = optionsList.item;
const optionsQuery = query(optionsList.data);
const resetAttribute = controls[2];
assert.ok(typeof resetAttribute === 'object' && resetAttribute.onClick);
const resetAttributeQuery = query(resetAttribute.onClick.slice(1));
const resetAll = populationFilter.content.content[1];
assert.ok(resetAll.onClick);
const resetAllQuery = query(resetAll.onClick.slice(1));
const summaryView = populationFilter.content.content[2].content;
assert.ok(summaryView);
const summaryQuery = query(summaryView.data);

function getOptions(breakdown: ProfileLineBreakdown) {
    const filters = query(list.data)(breakdown) as SetAttributeFilter[];
    return filters.flatMap(filter => {
        const context = query(filterContext)(filter, {});
        const options = optionsQuery(filter, context) as FilterOption[];
        return options.map(option => ({
            filterKey: filter.key,
            key: option.key,
            checked: query(checkbox.checked.slice(1))(option, context) as boolean,
            change: query(checkbox.onChange.slice(1))(option, context) as (enabled: boolean) => void
        }));
    });
}

test('renders settings from registered filters and preserves other filters and range', async () => {
    const { profile } = await createProfileFixture({ contexts: [1, 2, 1, 0] });
    const original = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location')!;
    const mapped = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location-sm')!;
    const population = original.populationFiltered;
    const category = population.filter.get('category') as SetAttributeFilter;
    const options = getOptions(original);
    assert.ok(options.length > 1);
    assert.ok(options.every(option => option.checked));
    population.setRange(5, 100);
    population.filter.batch(() => options.forEach(option => option.change(false)));
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
    assert.equal(population.sink.total, 95);
    assert.ok(getOptions(mapped).every(option => !option.checked));
    for (const breakdown of [original, mapped]) {
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 0);
    }

    const custom = new SetAttributeFilter('custom', 'Custom', 'sample', population.samplesMask.length, [{ key: 'all', label: 'All' }], () => 0);
    population.filter.add(custom);
    custom.setEnabled('all', false);
    resetAttributeQuery(category, { attributeFilter: category })();
    assert.equal(custom.active, true);
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
    assert.ok(getOptions(original).filter(option => option.key !== 'all').every(option => option.checked));
    assert.equal(population.rangeStart, 5);
    assert.equal(population.rangeEnd, 100);
    resetAllQuery(original)();
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 95);
    assert.equal(population.sink.total, 0);
    population.resetRange();
    assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
});

test('keeps category and event-filter data/context chains and derives summary in Jora', async () => {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const filters = query(list.data)(breakdown) as SetAttributeFilter[];
    assert.deepEqual(filters.map(filter => filter.key), ['category', 'allocationLiveness', 'allocationSpace']);
    for (const filter of filters) {
        assert.equal(filter, breakdown.populationFiltered.filter.get(filter.key));
        const context = query(filterContext)(filter, { kept: 'context' });
        assert.equal(context.kept, 'context');
        assert.equal(context.attributeFilter, filter);
    }
    const options = getOptions(breakdown);
    const liveness = options.find(option => option.filterKey === 'allocationLiveness' && option.key === 'gced')!;
    const space = options.find(option => option.filterKey === 'allocationSpace' && option.key === 'old_space')!;
    breakdown.populationFiltered.filter.batch(() => {
        liveness.change(false); space.change(false);
    });
    assert.deepEqual(summaryQuery(breakdown), { included: 16, excluded: 144 });
    const updated = getOptions(breakdown);
    assert.equal(updated.find(option => option.filterKey === 'allocationLiveness' && option.key === 'gced')!.checked, false);
    assert.equal(updated.find(option => option.filterKey === 'allocationSpace' && option.key === 'old_space')!.checked, false);
    assert.ok(updated.filter(option => option.filterKey === 'category').every(option => option.checked));
    const livenessFilter = filters.find(filter => filter.key === 'allocationLiveness')!;
    resetAttributeQuery(livenessFilter, { attributeFilter: livenessFilter })();
    assert.deepEqual(summaryQuery(breakdown), { included: 48, excluded: 112 });
    resetAllQuery(breakdown)();
    assert.deepEqual(summaryQuery(breakdown), { included: 160, excluded: 0 });
});

test('contains no page-local functions for data, context or interaction', () => {
    function check(value: unknown) {
        assert.notEqual(typeof value, 'function');
        if (value && typeof value === 'object') {
            Object.values(value).forEach(check);
        }
    }
    check(populationFilter);
});
