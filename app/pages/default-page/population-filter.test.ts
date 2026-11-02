import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { populationFilter } from '../../views/population-filter.config.js';
import { SetAttributeFilter, type FilterOption } from '../../prepare/computations/attribute-filter.js';
import type { ProfileLineBreakdown } from '../../prepare/lines/types.js';
import jora from 'jora';
import { methods, assertions } from '../../jora/index.mjs';

const query = jora.setup({ methods, assertions });
const filtersQuery = query(populationFilter.filters.slice(1));
const filterOptionsQuery = query(populationFilter.options.slice(1));
const optionTotalsQuery = query(populationFilter.optionTotals.slice(1));
const filterContext = populationFilter.group.context;
const optionsList = populationFilter.group.content;
assert.ok(typeof optionsList === 'object' && optionsList.item);
const checkbox = optionsList.item[0];
assert.ok(checkbox.checked && checkbox.onChange);
const optionsQuery = query(optionsList.data);
const resetAttribute = populationFilter.resetAttribute;
assert.ok(typeof resetAttribute === 'object' && resetAttribute.onClick);
const resetAttributeQuery = query(resetAttribute.onClick.slice(1));
const resetAllQuery = query(populationFilter.onReset.slice(1));
const summaryView = populationFilter.summary.content;
assert.ok(summaryView);
const summaryQuery = query(summaryView.data);

function getOptions(breakdown: ProfileLineBreakdown) {
    const filters = filtersQuery(breakdown) as SetAttributeFilter[];
    const filterOptions = filterOptionsQuery(breakdown) as (filter: SetAttributeFilter) => FilterOption[];
    return filters.flatMap(filter => {
        const group = { filter, options: filterOptions(filter) };
        const context = query(filterContext)(group, {});
        const options = optionsQuery(group, context) as FilterOption[];
        return options.map(option => ({
            filterKey: filter.key,
            key: option.key,
            checked: query(checkbox.checked.slice(1))(option, context) as boolean,
            change: query(checkbox.onChange.slice(1))(option, context) as (enabled: boolean) => void
        }));
    });
}

test('renders settings from registered filters and preserves other filters and range', async () => {
    const { profile } = await createProfileFixture({ contexts: [1, 2, 1, 0], allocationGc: [0, 1, 0, 2] });
    const original = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location')!;
    const mapped = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location-sm')!;
    const population = original.populationFiltered;
    const category = original.line.filters.get('category') as SetAttributeFilter;
    const options = getOptions(original);
    assert.ok(options.length > 1);
    assert.ok(options.every(option => option.checked));
    original.line.range.setRange(5, 100);
    original.line.filters.batch(() => options.forEach(option => option.change(false)));
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
    assert.equal(population.sink.total, 95);
    assert.ok(getOptions(mapped).every(option => !option.checked));
    for (const breakdown of [original, mapped]) {
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 0);
    }

    const liveness = original.line.filters.get('allocationLiveness') as SetAttributeFilter;
    resetAttributeQuery(category, { attributeFilter: category })();
    assert.equal(liveness.active, true);
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
    assert.ok(getOptions(original).filter(option => option.filterKey === 'category').every(option => option.checked));
    assert.ok(getOptions(original).filter(option => option.filterKey === 'allocationLiveness').every(option => !option.checked));
    assert.equal(population.rangeStart, 5);
    assert.equal(population.rangeEnd, 100);
    resetAllQuery(original)();
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 95);
    assert.equal(population.sink.total, 0);
    original.line.range.resetRange();
    assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
});

test.each(['exclude', 'include'] as const)('keeps data/context chains and derives summary in Jora in %s mode', async mode => {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const filters = filtersQuery(breakdown) as SetAttributeFilter[];
    assert.deepEqual(filters.map(filter => filter.key), ['category', 'allocationSpace', 'allocationLiveness']);
    if (mode === 'include') {
        breakdown.line.filters.batch(() => {
            for (const filter of filters) {
                filter.setSelection('include', filter.options.map(option => option.key));
            }
        });
    }
    for (const filter of filters) {
        assert.equal(filter, breakdown.line.filters.get(filter.key));
        assert.equal(filter.key, breakdown.populationViewport.filter.get(filter.key)!.key);
        const context = query(filterContext)({ filter, options: filter.options }, { kept: 'context' });
        assert.equal(context.kept, 'context');
        assert.equal(context.attributeFilter, filter);
    }
    const options = getOptions(breakdown);
    const liveness = options.find(option => option.filterKey === 'allocationLiveness' && option.key === 'gced')!;
    const space = options.find(option => option.filterKey === 'allocationSpace' && option.key === 'old_space')!;
    breakdown.line.filters.batch(() => {
        liveness.change(false); space.change(false);
    });
    assert.deepEqual(summaryQuery(breakdown), { included: 16, excluded: 144 });
    breakdown.line.range.setRange(80, 120);
    assert.deepEqual(summaryQuery(breakdown), { included: 16, excluded: 144 });
    breakdown.line.range.resetRange();
    const updated = getOptions(breakdown);
    assert.equal(updated.find(option => option.filterKey === 'allocationLiveness' && option.key === 'gced')!.checked, false);
    assert.equal(updated.find(option => option.filterKey === 'allocationSpace' && option.key === 'old_space')!.checked, false);
    assert.ok(updated.filter(option => option.filterKey === 'category').every(option => option.checked));
    const livenessFilter = filters.find(filter => filter.key === 'allocationLiveness')!;
    assert.equal(livenessFilter.mode, mode);
    assert.deepEqual(livenessFilter.selectedKeys, mode === 'include' ? ['alive'] : ['gced']);
    query('resetFilter()')(livenessFilter);
    assert.equal(livenessFilter.mode, mode);
    assert.deepEqual(livenessFilter.selectedKeys, []);
    assert.deepEqual(summaryQuery(breakdown), { included: mode === 'include' ? 0 : 48, excluded: mode === 'include' ? 160 : 112 });
    resetAttributeQuery(livenessFilter, { attributeFilter: livenessFilter })();
    assert.deepEqual(summaryQuery(breakdown), { included: 48, excluded: 112 });
    resetAllQuery(breakdown)();
    assert.deepEqual(summaryQuery(breakdown), { included: 160, excluded: 0 });
});

test.each(['exclude', 'include'] as const)('option totals use the remaining population in %s mode', async mode => {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const space = breakdown.line.filters.get('allocationSpace') as SetAttributeFilter;
    const liveness = breakdown.line.filters.get('allocationLiveness') as SetAttributeFilter;
    const totals = optionTotalsQuery(breakdown) as (filter: SetAttributeFilter) => Map<string, number>;

    if (mode === 'include') {
        breakdown.line.filters.batch(() => {
            space.setSelection(mode, space.options.map(option => option.key));
            liveness.setSelection(mode, liveness.options.map(option => option.key));
        });
    }

    assert.deepEqual(totals(space), new Map([['new_space', 48], ['old_space', 112]]));
    assert.deepEqual(totals(liveness), new Map([['alive', 64], ['gced', 96]]));
    space.setEnabled('old_space', false);
    assert.deepEqual(totals(space), new Map([['new_space', 48], ['old_space', 0]]));
    assert.deepEqual(totals(liveness), new Map([['alive', 16], ['gced', 32]]));
    liveness.setEnabled('gced', false);
    assert.deepEqual(totals(space), new Map([['new_space', 16], ['old_space', 0]]));
    assert.deepEqual(totals(liveness), new Map([['alive', 16], ['gced', 0]]));

    breakdown.line.range.setRange(80, 120);
    assert.deepEqual(totals(space), new Map([['new_space', 16], ['old_space', 0]]));
    breakdown.line.viewport.setRange(8, 100);
    assert.deepEqual(totals(space), new Map([['new_space', 8], ['old_space', 0]]));
    breakdown.line.filters.allowAll();
    assert.deepEqual(totals(space), new Map([['new_space', 40], ['old_space', 52]]));
    assert.deepEqual(totals(liveness), new Map([['alive', 56], ['gced', 36]]));

    liveness.setSelection('include', []);
    assert.deepEqual(totals(space), new Map([['new_space', 0], ['old_space', 0]]));
    assert.deepEqual(totals(liveness), new Map([['alive', 0], ['gced', 0]]));
});

test.each(['timeline', 'memline'] as const)('category totals partition the remaining %s population', async lineType => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const line = profile[lineType]!;

    for (const breakdown of line.breakdowns) {
        const category = line.filters.get('category') as SetAttributeFilter;
        const totals = optionTotalsQuery(breakdown) as (filter: SetAttributeFilter) => Map<string, number>;
        const included = () => breakdown.populationViewport.samplesTotal.reduce((sum, value) => sum + value, 0);
        const categoryTotal = () => [...totals(category).values()].reduce((sum, value) => sum + value, 0);

        assert.equal(categoryTotal(), included());
        assert.ok(categoryTotal() > 0);
        if (lineType === 'memline') {
            const liveness = line.filters.get('allocationLiveness') as SetAttributeFilter;
            liveness.setEnabled('gced', false);
            assert.equal(categoryTotal(), 64);
            liveness.allowAll();
        }

        category.setSelection('include', []);
        assert.equal(categoryTotal(), 0);
        category.allowAll();
        assert.equal(categoryTotal(), included());
    }
});

test('compilation stage totals merge only admitted allocations', async () => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'location')!;
    const stages = ['none', 'Compile', 'FinalizeUnoptimizedCompilationJob'];
    breakdown.line.attributes.push({
        name: 'allocationCompilationStage',
        values: new Uint8Array([1, 2, 1, 0]),
        dict: stages
    });
    const stageFilter = new SetAttributeFilter('allocationCompilationStage', 'Compilation stage',
        stages.map(key => ({ key, label: key })));
    const totals = optionTotalsQuery(breakdown) as (filter: SetAttributeFilter) => Map<string, number>;

    assert.deepEqual(totals(stageFilter), new Map([
        ['none', 64], ['Compile', 64], ['FinalizeUnoptimizedCompilationJob', 32]
    ]));
    const liveness = breakdown.line.filters.get('allocationLiveness') as SetAttributeFilter;
    liveness.setEnabled('gced', false);
    assert.deepEqual(totals(stageFilter), new Map([
        ['none', 0], ['Compile', 64], ['FinalizeUnoptimizedCompilationJob', 0]
    ]));
});

test('filter options omit absent values but retain values excluded by filters or viewport', async () => {
    const { profile } = await createProfileFixture({
        allocationGc: [0, 0, 0, 0],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space', 3: 'code_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const options = filterOptionsQuery(breakdown) as (filter: SetAttributeFilter) => FilterOption[];
    const category = breakdown.line.filters.get('category') as SetAttributeFilter;
    const space = breakdown.line.filters.get('allocationSpace') as SetAttributeFilter;
    const liveness = breakdown.line.filters.get('allocationLiveness') as SetAttributeFilter;

    assert.ok(category.options.some(option => option.key === 'root'));
    assert.ok(space.options.some(option => option.key === 'code_space'));
    assert.deepEqual(options(category).map(option => option.key), ['script']);
    assert.deepEqual(options(space).map(option => option.key), ['new_space', 'old_space']);
    assert.deepEqual(options(liveness).map(option => option.key), ['alive']);

    space.setEnabled('old_space', false);
    breakdown.line.viewport.setRange(0, 16);
    assert.deepEqual(options(space).map(option => option.key), ['new_space', 'old_space']);
    assert.deepEqual(options(category).map(option => option.key), ['script']);

    liveness.setSelection('include', []);
    assert.deepEqual(options(liveness).map(option => option.key), ['alive']);
    assert.deepEqual(options(space).map(option => option.key), ['new_space', 'old_space']);
});

test('compilation filter options omit unused stages without changing the registered dictionary', async () => {
    const { profile } = await createProfileFixture();
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'location')!;
    const stages = ['none', 'Compile', 'Unused'];
    breakdown.line.attributes.push({
        name: 'allocationCompilationStage', values: new Uint8Array([1, 1, 1, 1]), dict: stages
    });
    const filter = new SetAttributeFilter('allocationCompilationStage', 'Compilation stage',
        stages.map(key => ({ key, label: key })));
    const options = filterOptionsQuery(breakdown) as (filter: SetAttributeFilter) => FilterOption[];

    assert.deepEqual(options(filter).map(option => option.key), ['Compile']);
    assert.deepEqual(filter.options.map(option => option.key), stages);
});

test('composed Only action selects the visible option without resetting other filters', async () => {
    const { profile } = await createProfileFixture({
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space', 3: 'code_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const space = breakdown.line.filters.get('allocationSpace') as SetAttributeFilter;
    const liveness = breakdown.line.filters.get('allocationLiveness') as SetAttributeFilter;
    const options = filterOptionsQuery(breakdown)(space) as FilterOption[];
    const context = query(filterContext)({ filter: space, options }, {});
    const only = optionsList.item[1];
    assert.ok(only.onClick);

    liveness.setEnabled('gced', false);
    query(only.onClick.slice(1))(options.find(option => option.key === 'old_space'), context)();

    assert.equal(space.mode, 'include');
    assert.deepEqual(space.selectedKeys, ['old_space']);
    assert.equal(liveness.isEnabled('gced'), false);
    assert.deepEqual(summaryQuery(breakdown), { included: 48, excluded: 112 });
});

test('summary presents included first and hides excluded until nonzero', () => {
    const labels = summaryView.content.map(column => query(column.content[0].content.slice(5))({}));
    assert.deepEqual(labels, ['Included:', 'Excluded:']);

    const excluded = summaryView.content[1];
    assert.ok(excluded.when);
    assert.equal(query(excluded.when)({ excluded: 0 }), false);
    assert.equal(query(excluded.when)({ excluded: 1 }), true);
    assert.equal(excluded.content[2].view, 'button');
    assert.equal(excluded.content[2].text, 'Reset all');
});

test('summary reset action clears filters without changing the selected range', async () => {
    const { profile } = await createProfileFixture();
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const filters = filtersQuery(breakdown) as SetAttributeFilter[];
    filters[0].setSelection('include', []);
    breakdown.line.range.setRange(5, 100);

    const reset = summaryView.content[1].content[2];
    assert.ok(reset.onClick);
    query(reset.onClick.slice(1))({}, { resetPopulationFilter: resetAllQuery(breakdown) })();

    assert.ok(filters.every(filter => !filter.active));
    assert.equal(summaryQuery(breakdown).excluded, 0);
    assert.equal(breakdown.populationFiltered.rangeStart, 5);
    assert.equal(breakdown.populationFiltered.rangeEnd, 100);
});

test('binds option and summary numbers to text-numeric on every render', async () => {
    const { profile } = await createProfileFixture();
    const context = { scopeLine: profile.memline };
    const metrics = optionsList.item[2].content;
    assert.ok(metrics);
    assert.ok(metrics.every(metric => metric.view === 'text-numeric'));

    for (const total of [12345678, 0, 12345678]) {
        const data = { total, percent: total > 0 ? '42.3%' : '0.0%' };
        assert.equal(query(metrics[0].text.slice(1))(data, context), profile.memline!.formatValue(total));
        assert.equal(query(metrics[1].text.slice(1))(data, context), data.percent);

        const summary = { excluded: total, included: total };
        for (const column of summaryView.content) {
            const numeric = column.content[1].content;
            assert.ok(numeric.startsWith('text-numeric:'));
            assert.equal(query(numeric.slice('text-numeric:'.length))(summary, context), profile.memline!.formatValue(total));
        }
    }
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
