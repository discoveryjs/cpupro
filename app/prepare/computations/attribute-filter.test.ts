import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SetAttributeFilter } from './attribute-filter.js';

test.each(['include', 'exclude'] as const)('reset clears keys without changing %s mode', mode => {
    const filter = new SetAttributeFilter('category', 'Categories', [{ key: 'script', label: 'Script' }]);
    filter.setSelection(mode, ['script', 'absent']);
    let notifications = 0;
    filter.subscribe(() => notifications++);
    filter.reset();
    assert.equal(filter.mode, mode);
    assert.deepEqual(filter.selectedKeys, []);
    assert.equal(filter.isEnabled('script'), mode === 'exclude');
    assert.equal(filter.active, mode === 'include');
    assert.equal(notifications, 1);
    filter.reset();
    assert.equal(notifications, 1);
    filter.allowAll();
    assert.equal(filter.mode, 'exclude');
    assert.equal(filter.active, false);
    assert.equal(filter.isEnabled('absent'), true);
    filter.allowAll();
    assert.equal(notifications, mode === 'include' ? 2 : 1);
});

test('grows options by semantic key, preserves absent selections and ignores no-op updates', () => {
    const filter = new SetAttributeFilter('category', 'Categories', [{ key: 'script', label: 'Script' }]);
    filter.setSelection('include', ['later']);
    const revision = filter.revision;
    let changes = 0;
    filter.subscribe(() => changes++);
    filter.addOptions([{ key: 'script', label: 'Script' }, { key: 'later', label: 'Later' }, { key: 'later', label: 'Later' }]);
    assert.equal(changes, 1);
    assert.equal(filter.revision, revision + 1);
    assert.deepEqual(filter.options.map(option => option.key), ['script', 'later']);
    assert.deepEqual(filter.selectedKeys, ['later']);
    assert.equal(filter.isEnabled('later'), true);
    assert.equal(filter.isEnabled('script'), false);
    filter.addOptions([{ key: 'later', label: 'Later' }]);
    filter.setSelection('include', ['later', 'later']);
    filter.setEnabled('later', true);
    assert.equal(changes, 1);
    assert.throws(() => filter.setEnabled('unknown', true), /Unknown option/);
    const reordered = new SetAttributeFilter('category', 'Categories', [...filter.options].reverse());
    reordered.setSelection(filter.mode, filter.selectedKeys);
    assert.deepEqual(reordered.options.map(option => reordered.isEnabled(option.key)), [true, false]);
});
