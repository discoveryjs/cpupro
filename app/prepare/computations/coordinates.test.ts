import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CoordinateFrame, normalizeRanges, equalRanges, isRange, validateRange } from './coordinates.js';

test('accepts finite ordered ranges and rejects open bounds', () => {
    for (const [start, end] of [[null, null], [null, -1], [-1, null]] as const) {
        assert.equal(isRange({ start, end }), false);
    }
    for (const range of [{ start: -2, end: 1 }, { start: 0, end: 0 }, { start: 0.5, end: 1.5 }]) {
        assert.doesNotThrow(() => validateRange(range));
        assert.equal(isRange(range), true);
    }
});

test('rejects non-finite, reversed and malformed ranges', () => {
    for (const [start, end] of [[NaN, null], [null, Infinity], [-Infinity, null], [null, NaN], [2, 1]] as const) {
        assert.equal(isRange({ start, end }), false);
    }
    for (const value of [undefined, null, {}, [], { start: 0 }, { start: '0', end: 1 }]) {
        assert.equal(isRange(value), false);
    }
});

test('compares normalized ranges and distinguishes unrestricted from empty', () => {
    const ranges = normalizeRanges([{ start: 1, end: 3 }, { start: 5, end: 8 }]);

    assert.equal(equalRanges(null, null), true);
    assert.equal(equalRanges(null, []), false);
    assert.equal(equalRanges([], null), false);
    assert.equal(equalRanges([], []), true);
    assert.equal(equalRanges(ranges, ranges), true);
    assert.equal(equalRanges(ranges, [{ start: 1, end: 3 }, { start: 5, end: 8 }]), true);
    assert.equal(equalRanges(ranges, [{ start: 1, end: 3 }]), false);
    assert.equal(equalRanges(ranges, [{ start: 2, end: 3 }, { start: 5, end: 8 }]), false);
    assert.equal(equalRanges(ranges, [{ start: 1, end: 3 }, { start: 5, end: 9 }]), false);
});

test('normalizes into sorted, merged, frozen copies without empty intervals', () => {
    const source = [
        { start: 10, end: 12 },
        { start: 2, end: 3 },
        { start: 0, end: 5 },
        { start: 7, end: 7 },
        { start: 5, end: 6 }
    ];
    const ranges = normalizeRanges(source);

    assert.deepEqual(ranges, [{ start: 0, end: 6 }, { start: 10, end: 12 }]);
    assert.ok(Object.isFrozen(ranges) && ranges.every(Object.isFrozen));
    assert.deepEqual(source.map(range => range.start), [10, 2, 0, 7, 5]);
    assert.equal(source.some(Object.isFrozen), false);

    source[2].start = 100;
    assert.equal(ranges[0].start, 0);
    assert.deepEqual(normalizeRanges([{ start: 0, end: 0 }]), []);
    assert.deepEqual(normalizeRanges([]), []);
});

test.each([
    { start: 5, end: 1 },
    { start: NaN, end: 1 },
    { start: 0, end: NaN },
    { start: 0, end: Infinity },
    { start: Infinity, end: Infinity }
])('normalizing rejects [$start, $end) among valid ranges', invalid => {
    assert.throws(() => normalizeRanges([{ start: 0, end: 1 }, invalid]), RangeError);
});

test('a frame converts values and ranges between its local coordinates and its space', () => {
    const frame = new CoordinateFrame({ name: 'time', unit: 'us' }, 100);

    assert.equal(frame.rebaseValue(110), 10);
    assert.equal(frame.resolveValue(10), 110);
    assert.deepEqual(frame.rebase([{ start: 95, end: 105 }]), [{ start: -5, end: 5 }]);
    assert.deepEqual(frame.resolve([{ start: -5, end: 5 }]), [{ start: 95, end: 105 }]);
    assert.throws(() => frame.setOrigin(NaN), RangeError);
});
