import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { allocationAttributes, findBreakdown } from '../../test/fixtures/lines.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';
import { filterOptionTotals, filterOptions } from './filters.js';
import type { ProfileLineBreakdown } from '../prepare/lines/types.js';
import { sum } from '../../test/helpers/values.js';

// A CPU sample 0 mapping attributes every allocation of the call-stack breakdown to one sample;
// code space is an option without allocations
const allocationEvents = {
    ...allocationAttributes,
    mapping: [0, 4, 4],
    allocationSpaceNames: { 1: 'new_space', 2: 'old_space', 3: 'code_space' }
};

async function createBreakdown(kind: string, options: Parameters<typeof createProfileFixture>[0] = allocationEvents) {
    const { profile } = await createProfileFixture(options);
    const breakdown = findBreakdown(profile.memline!, kind);
    const filter = (key: string) => breakdown.line.filters.get(key) as SetAttributeFilter;

    return { profile, breakdown, filter };
}

function addCompilationStages(breakdown: ProfileLineBreakdown, values: number[], stages: string[]) {
    const options = stages.map(key => ({ key, label: key }));

    breakdown.line.attributes.push({
        name: 'allocationCompilationStage',
        values: Uint8Array.from(values),
        dict: stages
    });

    return new SetAttributeFilter('allocationCompilationStage', 'Compilation stage', options);
}

function optionKeys(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    return filterOptions(breakdown, filter).map(option => option.key);
}

// Totals of the options of a filter by option key
function optionTotals(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    return Object.fromEntries(filterOptionTotals(breakdown, filter));
}

test('options are the values present in the line, regardless of filters and viewport', async () => {
    const options = {
        ...allocationEvents,
        allocationGc: [0, 0, 0, 0]
    };
    const { breakdown, filter } = await createBreakdown('call-stack', options);
    const presentOptions = () => ({
        category: optionKeys(breakdown, filter('category')),
        allocationSpace: optionKeys(breakdown, filter('allocationSpace')),
        allocationLifespan: optionKeys(breakdown, filter('allocationLifespan'))
    });
    const expected = {
        category: ['script'],
        allocationSpace: ['new_space', 'old_space'],
        allocationLifespan: ['alive']
    };

    assert.ok(filter('category').options.length > 1);
    assert.equal(filter('allocationSpace').options.length, 3);
    assert.deepEqual(presentOptions(), expected);

    filter('allocationSpace').setEnabled('old_space', false);
    filter('allocationLifespan').setSelection('include', []);
    breakdown.line.viewport.setRange(0, 16);

    assert.deepEqual(presentOptions(), expected);
});

test('compilation stage options omit unused stages without changing the registered dictionary', async () => {
    const { breakdown } = await createBreakdown('location', {});
    const stages = ['none', 'Compile', 'Unused'];
    const filter = addCompilationStages(breakdown, [1, 1, 1, 1], stages);

    assert.deepEqual(optionKeys(breakdown, filter), ['Compile']);
    assert.deepEqual(filter.options.map(option => option.key), stages);
});

function includeEveryOption(filter: SetAttributeFilter) {
    filter.setSelection('include', filter.options.map(option => option.key));
}

test.each([
    { selection: 'the default exclusion of nothing', prepare: () => {} },
    { selection: 'an inclusion of every option', prepare: includeEveryOption }
])('option totals are taken from the viewport population after the other filters, with $selection', async row => {
    const { breakdown, filter } = await createBreakdown('call-stack');
    const space = filter('allocationSpace');
    const lifespan = filter('allocationLifespan');

    breakdown.line.filters.batch(() => {
        row.prepare(space);
        row.prepare(lifespan);
    });

    assert.deepEqual(optionTotals(breakdown, space), { new_space: 48, old_space: 112, code_space: 0 });
    assert.deepEqual(optionTotals(breakdown, lifespan), { 'alive': 64, 'short-lived': 32, 'long-lived': 64 });

    // An option's own exclusion shows as zero, the other filter totals shrink to the admitted events
    space.setEnabled('old_space', false);
    assert.deepEqual(optionTotals(breakdown, space), { new_space: 48, old_space: 0, code_space: 0 });
    assert.deepEqual(optionTotals(breakdown, lifespan), { 'alive': 16, 'short-lived': 32, 'long-lived': 0 });

    lifespan.setEnabled('short-lived', false);
    lifespan.setEnabled('long-lived', false);
    assert.deepEqual(optionTotals(breakdown, space), { new_space: 16, old_space: 0, code_space: 0 });

    // The selection range does not limit totals, the viewport does
    breakdown.line.range.setRange(80, 120);
    assert.deepEqual(optionTotals(breakdown, space), { new_space: 16, old_space: 0, code_space: 0 });
    breakdown.line.viewport.setRange(8, 100);
    assert.deepEqual(optionTotals(breakdown, space), { new_space: 8, old_space: 0, code_space: 0 });

    breakdown.line.filters.allowAll();
    assert.deepEqual(optionTotals(breakdown, space), { new_space: 40, old_space: 52, code_space: 0 });
    assert.deepEqual(optionTotals(breakdown, lifespan), { 'alive': 56, 'short-lived': 32, 'long-lived': 4 });
});

const lineTypes = ['timeline', 'memline'] as const;

test.each(lineTypes)('category totals partition the viewport population of every %s breakdown', async lineType => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const line = profile[lineType]!;
    const category = line.filters.get('category') as SetAttributeFilter;

    for (let i = 0; i < line.breakdowns.length; i++) {
        const breakdown = line.breakdowns[i];
        const included = sum(breakdown.populationViewport.samplesTotal);
        const categoryTotal = () => sum([...filterOptionTotals(breakdown, category).values()]);

        assert.ok(included > 0);
        assert.equal(categoryTotal(), included);

        category.setSelection('include', []);
        assert.equal(categoryTotal(), 0);

        category.allowAll();
    }
});

test('category totals continue past samples without a value in the viewport', async () => {
    // Events 0 and 3 (16 and 64 bytes) belong to CPU samples 0 and 2, events 1 and 2 (32 and 48 bytes) to CPU sample 1
    const { breakdown, filter } = await createBreakdown('call-stack', { mapping: [1, 3, 4] });

    breakdown.line.viewport.setRange(16, 96);
    const totals = filterOptionTotals(breakdown, filter('category'));

    assert.deepEqual([...breakdown.populationViewport.samplesTotal], [0, 80, 0]);
    assert.equal(sum([...totals.values()]), 80);
});

test('compilation stage totals count only admitted allocations', async () => {
    const { breakdown, filter } = await createBreakdown('location', { allocationGc: [0, 1, 0, 2] });
    const stages = addCompilationStages(breakdown, [1, 2, 1, 0], ['none', 'Compile', 'Finalize']);

    assert.deepEqual(optionTotals(breakdown, stages), { none: 64, Compile: 64, Finalize: 32 });

    filter('allocationLifespan').setSelection('include', ['alive']);
    assert.deepEqual(optionTotals(breakdown, stages), { none: 0, Compile: 64, Finalize: 0 });
});
