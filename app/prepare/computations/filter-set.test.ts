import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FilterSet } from './filter-set.js';
import { SetAttributeFilter } from './attribute-filter.js';

function createFilterSet() {
    const filters = new FilterSet();
    const first = new SetAttributeFilter('first', 'First', []);
    const second = new SetAttributeFilter('second', 'Second', []);
    const counter = { notifications: 0 };

    filters.subscribe(() => counter.notifications++);

    return { filters, first, second, counter };
}

test('filters are registered by key in order of adding, each adding notifies', () => {
    const { filters, first, second, counter } = createFilterSet();

    assert.deepEqual(filters.filters, []);
    filters.add(first);
    filters.add(second);

    assert.equal(counter.notifications, 2);
    assert.deepEqual(filters.filters, [first, second]);
    assert.equal(filters.get('second'), second);
    assert.equal(filters.get('absent'), undefined);
    assert.throws(() => filters.add(first), /already defined/);
});

test('changes of registered filters notify until they are removed', () => {
    const { filters, first, second, counter } = createFilterSet();

    filters.add(first);
    filters.add(second);
    first.setSelection('include', ['a']);
    assert.equal(counter.notifications, 3);

    filters.remove('first');
    filters.remove('absent');
    first.setSelection('include', ['b']);
    assert.equal(counter.notifications, 4);
    assert.deepEqual(filters.filters, [second]);
});

function addAndChangeFilters(context: ReturnType<typeof createFilterSet>) {
    const { filters, first, second } = context;

    filters.add(first);
    first.setSelection('include', ['a']);
    filters.batch(() => filters.add(second));
}

test.each([
    { name: 'adding filters and changing them', notifications: 1, update: addAndChangeFilters },
    { name: 'no changes', notifications: 0, update: () => {} }
])('a batch with $name notifies $notifications times when the outermost batch ends', row => {
    const context = createFilterSet();

    context.filters.batch(() => row.update(context));
    assert.equal(context.counter.notifications, row.notifications);

    // A finished batch leaves nothing pending for the next one
    context.filters.batch(() => {});
    assert.equal(context.counter.notifications, row.notifications);
});

test.each([
    { method: 'reset', modes: ['include', 'exclude'] },
    { method: 'allowAll', modes: ['exclude', 'exclude'] }
] as const)('$method applies to every filter with one notification', row => {
    const { method, modes } = row;
    const { filters, first, second, counter } = createFilterSet();

    filters.add(first);
    filters.add(second);
    first.setSelection('include', ['a']);
    second.setSelection('exclude', ['b']);
    counter.notifications = 0;

    filters[method]();

    const states = [first, second].map(filter => [filter.mode, filter.selectedKeys]);

    assert.equal(counter.notifications, 1);
    assert.deepEqual(states, [[modes[0], []], [modes[1], []]]);
});
