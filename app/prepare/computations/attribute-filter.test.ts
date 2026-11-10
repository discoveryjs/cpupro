import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SetAttributeFilter } from './attribute-filter.js';

function createFilter() {
    const options = [
        { key: 'script', label: 'Script' },
        { key: 'gc', label: 'GC' }
    ];

    return new SetAttributeFilter('category', 'Categories', options);
}

test.each([
    { mode: 'exclude', keys: [], active: false, enabled: ['script', 'gc'] },
    { mode: 'exclude', keys: ['script'], active: true, enabled: ['gc'] },
    { mode: 'include', keys: [], active: true, enabled: [] },
    { mode: 'include', keys: ['script'], active: true, enabled: ['script'] }
] as const)('$mode of $keys enables $enabled', row => {
    const filter = createFilter();

    filter.setSelection(row.mode, row.keys);

    assert.equal(filter.active, row.active);
    assert.deepEqual(filter.options.map(option => option.key).filter(key => filter.isEnabled(key)), row.enabled);
});

test.each([
    { mode: 'exclude', enabled: true, active: false },
    { mode: 'include', enabled: false, active: true }
] as const)('reset clears the keys of $mode mode and keeps the mode, allowAll enables every key', row => {
    const { mode, enabled, active } = row;
    const filter = createFilter();

    filter.setSelection(mode, ['script', 'absent']);
    filter.reset();
    assert.equal(filter.mode, mode);
    assert.deepEqual(filter.selectedKeys, []);
    assert.equal(filter.isEnabled('script'), enabled);
    assert.equal(filter.active, active);

    filter.setSelection(mode, ['script']);
    filter.allowAll();
    assert.equal(filter.mode, 'exclude');
    assert.deepEqual(filter.selectedKeys, []);
    assert.equal(filter.active, false);
});

test.each([
    { mode: 'exclude', key: 'script', enabled: false, selected: ['gc', 'script'] },
    { mode: 'exclude', key: 'gc', enabled: true, selected: [] },
    { mode: 'include', key: 'script', enabled: true, selected: ['gc', 'script'] },
    { mode: 'include', key: 'gc', enabled: false, selected: [] }
] as const)('setEnabled($key, $enabled) in $mode mode of [gc] selects $selected', row => {
    const { mode, key, enabled, selected } = row;
    const filter = createFilter();

    filter.setSelection(mode, ['gc']);
    filter.setEnabled(key, enabled);

    assert.deepEqual(filter.selectedKeys.sort(), selected);
    assert.equal(filter.isEnabled(key), enabled);
});

test('unknown modes and options are rejected', () => {
    const filter = createFilter();

    assert.throws(() => filter.setSelection('other' as 'include', []), /Unknown filter mode/);
    assert.throws(() => filter.setEnabled('unknown', true), /Unknown option/);
});

// Filters are prepared again only when the revision differs from the prepared one, so a revision never repeats
test('every change notifies once and gives a new revision', () => {
    const filter = createFilter();
    const revisions = [filter.revision];
    const changes = [
        () => filter.setSelection('include', ['script']),
        () => filter.addOptions([{ key: 'idle', label: 'Idle' }]),
        () => filter.setEnabled('gc', true),
        () => filter.setEnabled('script', false),
        () => filter.reset(),
        () => filter.allowAll()
    ];
    let notifications = 0;

    filter.subscribe(() => notifications++);

    for (let i = 0; i < changes.length; i++) {
        changes[i]();
        revisions.push(filter.revision);
    }

    assert.equal(notifications, 6);
    assert.equal(new Set(revisions).size, 7);
});

test('updates without changes neither notify nor change the revision', () => {
    const filter = createFilter();
    let notifications = 0;

    filter.setSelection('include', ['script', 'absent']);
    const { revision } = filter;

    filter.subscribe(() => notifications++);
    filter.setSelection('include', ['absent', 'script', 'script']);
    filter.setEnabled('script', true);
    filter.setEnabled('gc', false);
    filter.addOptions([{ key: 'gc', label: 'Other label' }]);

    assert.equal(notifications, 0);
    assert.equal(filter.revision, revision);
});

test('options grow by key in order of arrival and select keys selected before they are added', () => {
    const filter = createFilter();

    filter.setSelection('include', ['later']);
    assert.equal(filter.isEnabled('later'), true);

    filter.addOptions([
        { key: 'later', label: 'Later' },
        { key: 'script', label: 'Script' },
        { key: 'later', label: 'Later' }
    ]);

    assert.deepEqual(filter.options.map(option => option.key), ['script', 'gc', 'later']);
    assert.deepEqual(filter.selectedKeys, ['later']);
    assert.deepEqual(filter.options.map(option => filter.isEnabled(option.key)), [false, false, true]);
});
