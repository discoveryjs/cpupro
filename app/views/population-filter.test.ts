import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { SetAttributeFilter, type FilterOption } from '../prepare/computations/attribute-filter.js';
import type { ProfileLineBreakdown } from '../prepare/lines/types.js';
import { methods, assertions } from '../jora/index.mjs';
import { populationFilter } from './population-filter.config.js';

const query = jora.setup({ methods, assertions });
const { group, resetAttribute, summary } = populationFilter;
const [checkbox, only, metrics] = group.content.item;
const [includedColumn, excludedColumn] = summary.content.content;
const [total, percent] = metrics.content ?? [];

assert.ok(typeof total === 'object' && typeof percent === 'object');

// A view property holds a query when it starts with "="
function evaluate(property: string | undefined, data: unknown, context: unknown = {}) {
    assert.ok(property !== undefined);

    return query(property.replace(/^=/, ''))(data, context);
}

// Fixture allocation events weigh 16, 32, 48 and 64 bytes. Events 0 and 2 are alive, events 0 and 1 are in
// new space, and a CPU sample 0 mapping attributes every allocation of the call-stack breakdown to one sample.
async function createBreakdown(kind = 'call-stack') {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === kind)!;
    const filter = (key: string) => breakdown.line.filters.get(key) as SetAttributeFilter;

    return { profile, breakdown, filter };
}

// The rendered option rows of one filter group with their checkbox state and actions
function renderOptions(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    const options = evaluate(populationFilter.options, breakdown)(filter) as FilterOption[];
    const context = evaluate(group.context, { filter, options });

    return options.map(option => ({
        key: option.key,
        checked: evaluate(checkbox.checked, option, context) as boolean,
        change: evaluate(checkbox.onChange, option, context) as (enabled: boolean) => void,
        only: evaluate(only.onClick, option, context) as () => void
    }));
}

function summarize(breakdown: ProfileLineBreakdown) {
    return evaluate(summary.content.data, breakdown);
}

test('lists the set filters registered for the line', async () => {
    const { breakdown, filter } = await createBreakdown();
    // Settings of another kind have no options to list
    const range = { key: 'range', label: 'Range', active: false, reset() {}, allowAll() {}, subscribe: () => () => {} };

    breakdown.line.filters.add(range);
    const filters = evaluate(populationFilter.filters, breakdown) as SetAttributeFilter[];

    assert.deepEqual(filters, [filter('category'), filter('allocationSpace'), filter('allocationLiveness')]);
});

test('a filter group keeps the outer context and exposes its filter', async () => {
    const { filter } = await createBreakdown();
    const space = filter('allocationSpace');
    const context = evaluate(group.context, { filter: space, options: space.options }, { kept: true });

    assert.equal(context.kept, true);
    assert.equal(context.attributeFilter, space);
});

test('checkboxes show and change whether an option is admitted', async () => {
    const { breakdown, filter } = await createBreakdown();
    const space = filter('allocationSpace');

    assert.deepEqual(renderOptions(breakdown, space).map(option => [option.key, option.checked]), [['new_space', true], ['old_space', true]]);

    renderOptions(breakdown, space)[1].change(false);

    assert.equal(space.isEnabled('old_space'), false);
    assert.deepEqual(renderOptions(breakdown, space).map(option => [option.key, option.checked]), [['new_space', true], ['old_space', false]]);
    assert.deepEqual(summarize(breakdown), { included: 48, excluded: 112 });
});

test('Only admits just its option and keeps the other filters', async () => {
    const { breakdown, filter } = await createBreakdown();
    const space = filter('allocationSpace');
    const liveness = filter('allocationLiveness');

    liveness.setEnabled('gced', false);
    renderOptions(breakdown, space)[1].only();

    assert.equal(space.mode, 'include');
    assert.deepEqual(space.selectedKeys, ['old_space']);
    assert.equal(liveness.isEnabled('gced'), false);
    assert.deepEqual(summarize(breakdown), { included: 48, excluded: 112 });
});

test('All admits every option of its filter and keeps the other filters', async () => {
    const { breakdown, filter } = await createBreakdown();
    const space = filter('allocationSpace');
    const liveness = filter('allocationLiveness');

    breakdown.line.filters.batch(() => {
        space.setSelection('include', []);
        liveness.setEnabled('gced', false);
    });
    evaluate(resetAttribute.onClick, space)();

    assert.equal(space.active, false);
    assert.equal(liveness.isEnabled('gced'), false);
    assert.deepEqual(summarize(breakdown), { included: 64, excluded: 96 });
});

test('the summary counts the viewport population and its reset admits everything, keeping the selection range', async () => {
    const { breakdown, filter } = await createBreakdown();
    const reset = evaluate(populationFilter.onReset, breakdown);

    breakdown.line.filters.batch(() => {
        filter('allocationSpace').setEnabled('old_space', false);
        filter('allocationLiveness').setEnabled('gced', false);
    });
    breakdown.line.range.setRange(80, 120);

    // Only event 0 (16 bytes) is alive and in new space; the selection range does not limit the summary
    assert.deepEqual(summarize(breakdown), { included: 16, excluded: 144 });

    evaluate(excludedColumn.content[2].onClick, {}, { resetPopulationFilter: reset })();

    assert.equal(breakdown.line.filters.filters.some(filter => filter.active), false);
    assert.deepEqual(summarize(breakdown), { included: 160, excluded: 0 });
    assert.deepEqual(breakdown.populationFiltered.ranges, [{ start: 80, end: 120 }]);
});

test('the excluded part of the summary shows only when something is excluded', () => {
    assert.equal(query(excludedColumn.when)({ excluded: 0 }), false);
    assert.equal(query(excludedColumn.when)({ excluded: 1 }), true);
});

test('numbers are formatted by the line of the scope', async () => {
    const { profile } = await createBreakdown();
    const context = { scopeLine: profile.memline };
    const formatted = profile.memline!.formatValue(12345678);

    assert.equal(evaluate(total.text, { total: 12345678 }, context), formatted);
    assert.equal(evaluate(percent.text, { percent: '42.3%' }, context), '42.3%');

    for (const column of [includedColumn, excludedColumn]) {
        const numeric = column.content[1].content;

        assert.ok(numeric !== undefined && numeric.startsWith('text-numeric:'));
        assert.equal(query(numeric.slice('text-numeric:'.length))({ included: 12345678, excluded: 12345678 }, context), formatted);
    }
});

test('the configuration is data only, without functions', () => {
    const pending: unknown[] = [populationFilter];

    while (pending.length > 0) {
        const value = pending.pop();

        assert.notEqual(typeof value, 'function');

        if (value !== null && typeof value === 'object') {
            pending.push(...Object.values(value));
        }
    }
});
