import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FilterSet } from './filter-set.js';
import { SetAttributeFilter } from './attribute-filter.js';

test('starts empty and grows without a population or attribution dependency', () => {
    const filters = new FilterSet();
    const first = new SetAttributeFilter('first', 'First', []);
    const second = new SetAttributeFilter('second', 'Second', []);
    let changes = 0;
    filters.subscribe(() => changes++);
    assert.deepEqual(filters.filters, []);
    filters.batch(() => {
        filters.add(first);
        first.setSelection('include', ['not-yet-available']);
        filters.batch(() => filters.add(second));
    });
    assert.equal(changes, 1);
    assert.equal(filters.get('first'), first);
    filters.reset();
    assert.equal(changes, 2);
    assert.equal(first.mode, 'include');
    assert.deepEqual(first.selectedKeys, []);
    filters.allowAll();
    assert.equal(changes, 3);
    assert.equal(first.active, false);
    assert.throws(() => filters.add(first), /already defined/);
    filters.remove('first');
    assert.equal(changes, 4);
    first.setSelection('include', ['detached']);
    assert.equal(changes, 4);
    assert.deepEqual(filters.filters, [second]);
});
