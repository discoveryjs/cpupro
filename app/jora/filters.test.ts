import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';
import { filterOptionTotals, filterOptions } from './filters.js';

// Fixture allocation events weigh 16, 32, 48 and 64 bytes. Events 0 and 2 are alive, events 0 and 1 are in
// new space, and a CPU sample 0 mapping attributes every allocation of the call-stack breakdown to one sample.
const allocationEvents = {
    mapping: [0, 4, 4],
    allocationGc: [0, 1, 0, 2],
    allocationSpaces: [1, 1, 2, 2],
    allocationSpaceNames: { 1: 'new_space', 2: 'old_space', 3: 'code_space' }
};

async function createBreakdown(kind: string, options: Parameters<typeof createProfileFixture>[0] = allocationEvents) {
    const { profile } = await createProfileFixture(options);
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === kind)!;
    const filter = (key: string) => breakdown.line.filters.get(key) as SetAttributeFilter;

    return { profile, breakdown, filter };
}

function addCompilationStages(breakdown: Awaited<ReturnType<typeof createBreakdown>>['breakdown'], values: number[], stages: string[]) {
    breakdown.line.attributes.push({ name: 'allocationCompilationStage', values: Uint8Array.from(values), dict: stages });

    return new SetAttributeFilter('allocationCompilationStage', 'Compilation stage', stages.map(key => ({ key, label: key })));
}

function optionKeys(...args: Parameters<typeof filterOptions>) {
    return filterOptions(...args).map(option => option.key);
}

test('options are the values present in the line, regardless of filters and viewport', async () => {
    const { breakdown, filter } = await createBreakdown('call-stack', { ...allocationEvents, allocationGc: [0, 0, 0, 0] });
    const expected = {
        category: ['script'],
        allocationSpace: ['new_space', 'old_space'],
        allocationLiveness: ['alive']
    };

    assert.ok(filter('category').options.length > 1);
    assert.equal(filter('allocationSpace').options.length, 3);

    for (const [key, keys] of Object.entries(expected)) {
        assert.deepEqual(optionKeys(breakdown, filter(key)), keys, key);
    }

    filter('allocationSpace').setEnabled('old_space', false);
    filter('allocationLiveness').setSelection('include', []);
    breakdown.line.viewport.setRange(0, 16);

    for (const [key, keys] of Object.entries(expected)) {
        assert.deepEqual(optionKeys(breakdown, filter(key)), keys, key);
    }
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
])('option totals are taken from the viewport population after the other filters, with $selection', async ({ prepare }) => {
    const { breakdown, filter } = await createBreakdown('call-stack');
    const space = filter('allocationSpace');
    const liveness = filter('allocationLiveness');

    breakdown.line.filters.batch(() => {
        prepare(space);
        prepare(liveness);
    });

    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 48], ['old_space', 112], ['code_space', 0]]));
    assert.deepEqual(filterOptionTotals(breakdown, liveness), new Map([['alive', 64], ['gced', 96]]));

    // An option's own exclusion shows as zero, the other filter totals shrink to the admitted events
    space.setEnabled('old_space', false);
    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 48], ['old_space', 0], ['code_space', 0]]));
    assert.deepEqual(filterOptionTotals(breakdown, liveness), new Map([['alive', 16], ['gced', 32]]));

    liveness.setEnabled('gced', false);
    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 16], ['old_space', 0], ['code_space', 0]]));

    // The selection range does not limit totals, the viewport does
    breakdown.line.range.setRange(80, 120);
    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 16], ['old_space', 0], ['code_space', 0]]));
    breakdown.line.viewport.setRange(8, 100);
    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 8], ['old_space', 0], ['code_space', 0]]));

    breakdown.line.filters.allowAll();
    assert.deepEqual(filterOptionTotals(breakdown, space), new Map([['new_space', 40], ['old_space', 52], ['code_space', 0]]));
    assert.deepEqual(filterOptionTotals(breakdown, liveness), new Map([['alive', 56], ['gced', 36]]));
});

test.each(['timeline', 'memline'] as const)('category totals partition the viewport population of every %s breakdown', async lineType => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const line = profile[lineType]!;
    const category = line.filters.get('category') as SetAttributeFilter;

    for (const breakdown of line.breakdowns) {
        const included = breakdown.populationViewport.samplesTotal.reduce((sum, value) => sum + value, 0);
        const categoryTotal = () => [...filterOptionTotals(breakdown, category).values()].reduce((sum, value) => sum + value, 0);

        assert.ok(included > 0);
        assert.equal(categoryTotal(), included);

        category.setSelection('include', []);
        assert.equal(categoryTotal(), 0);

        category.allowAll();
    }
});

test('category totals continue past samples without a value in the viewport', async () => {
    // Events 0 and 3 (16 and 64 bytes) belong to sample 0, events 1 and 2 (32 and 48 bytes) to sample 1
    const { breakdown, filter } = await createBreakdown('call-stack', { mapping: [1, 3, 4] });

    breakdown.line.viewport.setRange(16, 96);
    const totals = filterOptionTotals(breakdown, filter('category'));

    assert.deepEqual([...breakdown.populationViewport.samplesTotal], [0, 80]);
    assert.equal([...totals.values()].reduce((sum, value) => sum + value, 0), 80);
});

test('compilation stage totals count only admitted allocations', async () => {
    const { breakdown, filter } = await createBreakdown('location', { allocationGc: [0, 1, 0, 2] });
    const stages = addCompilationStages(breakdown, [1, 2, 1, 0], ['none', 'Compile', 'Finalize']);

    assert.deepEqual(filterOptionTotals(breakdown, stages), new Map([['none', 64], ['Compile', 64], ['Finalize', 32]]));

    filter('allocationLiveness').setEnabled('gced', false);
    assert.deepEqual(filterOptionTotals(breakdown, stages), new Map([['none', 0], ['Compile', 64], ['Finalize', 0]]));
});
