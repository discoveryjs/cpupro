import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CoordinateFrame, normalizeRanges, equalRanges, isRange, validateRange, validateRangeBounds } from './coordinates.js';
import { RangeSelection, RangeView } from './range.js';

test('allows open constraint bounds without accepting them as coordinate ranges', () => {
    for (const [start, end] of [[null, null], [null, -1], [-1, null]] as const) {
        assert.doesNotThrow(() => validateRangeBounds(start, end));
        assert.equal(isRange({ start, end }), false);
    }
    for (const range of [{ start: -2, end: 1 }, { start: 0, end: 0 }, { start: 0.5, end: 1.5 }]) {
        assert.doesNotThrow(() => validateRangeBounds(range.start, range.end));
        assert.doesNotThrow(() => validateRange(range));
        assert.equal(isRange(range), true);
    }
});

test('rejects non-finite and reversed constraint bounds, including one-sided constraints', () => {
    for (const [start, end] of [[NaN, null], [null, Infinity], [-Infinity, null], [null, NaN], [2, 1]] as const) {
        assert.throws(() => validateRangeBounds(start, end), RangeError);
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

test('rebases requested ranges, preserves gaps and separates absent coverage', () => {
    const space = { name: 'session-time', unit: 'us' };
    const local = new CoordinateFrame(space, 2);
    const selection = new RangeSelection(space);
    const view = new RangeView(selection, local, { start: 0, end: 11 });
    selection.setRanges([{ start: 12, end: 15 }, { start: 1, end: 3 }, { start: 5, end: 8 }]);
    const request = selection.ranges;
    assert.deepEqual(view.ranges, [{ start: -1, end: 1 }, { start: 3, end: 6 }, { start: 10, end: 13 }]);
    assert.deepEqual(view.coverage, [{ start: 0, end: 1 }, { start: 3, end: 6 }, { start: 10, end: 11 }]);
    assert.deepEqual(local.resolve(view.ranges!), request);
    local.setOrigin(20);
    assert.deepEqual(view.coverage, []);
    assert.equal(selection.ranges, request);
    local.setOrigin(2);
    view.setRange(1, 4);
    assert.deepEqual(selection.ranges, [{ start: 3, end: 6 }]);
    assert.deepEqual(view.ranges, [{ start: 1, end: 4 }]);
    view.setRanges([]);
    assert.deepEqual(view.coverage, []);
    view.resetRange();
    assert.equal(selection.ranges, null);
    assert.deepEqual(view.coverage, [{ start: 0, end: 11 }]);
});

test('normalizes immutable ranges and rejects unrelated coordinate spaces', () => {
    const source = [{ start: 2, end: 5 }, { start: 1, end: 2 }, { start: 4, end: 8 }, { start: 12, end: 12 }];
    const ranges = normalizeRanges(source);
    assert.deepEqual(ranges, [{ start: 1, end: 8 }]);
    assert.deepEqual(source.map(range => range.start), [2, 1, 4, 12]);
    assert.ok(source.every(range => !Object.isFrozen(range)));
    source[0].start = 100;
    assert.equal(ranges[0].start, 1);
    assert.ok(Object.isFrozen(ranges) && Object.isFrozen(ranges[0]));
    assert.throws(() => normalizeRanges([{ start: 5, end: 1 }]), RangeError);
    assert.throws(() => normalizeRanges([{ start: 0, end: Infinity }]), RangeError);
    const frame = new CoordinateFrame({ name: 'time', unit: 'us' });
    const selection = new RangeSelection({ name: 'another-time', unit: 'us' });
    assert.throws(() => new RangeView(selection, frame, { start: 0, end: 10 }), /explicit mapping/);
    assert.throws(() => frame.setOrigin(NaN), RangeError);
});

test('skips empty intervals and validates bounds while merging sorted ranges', () => {
    const input = Object.freeze([
        Object.freeze({ start: 10, end: 12 }),
        Object.freeze({ start: 2, end: 3 }),
        Object.freeze({ start: 0, end: 5 }),
        Object.freeze({ start: 7, end: 7 }),
        Object.freeze({ start: 5, end: 6 })
    ]);
    const result = normalizeRanges(input);
    assert.deepEqual(result, [{ start: 0, end: 6 }, { start: 10, end: 12 }]);
    assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen));
    assert.deepEqual(normalizeRanges([{ start: 0, end: 0 }]), []);
    assert.deepEqual(normalizeRanges([]), []);
    for (const invalid of [{ start: NaN, end: 1 }, { start: 0, end: NaN }, { start: Infinity, end: Infinity }, { start: 3, end: 2 }]) {
        assert.throws(() => normalizeRanges([...input, invalid]), RangeError);
    }
});

test('resolves timestamped point occurrences without sample or projection identity', () => {
    const space = { name: 'recorded-time', unit: 'us' };
    const local = new CoordinateFrame(space, 100);
    const selection = new RangeSelection(space);
    const view = new RangeView(selection, local, { start: 0, end: 20 });
    selection.setRanges([{ start: 95, end: 105 }, { start: 110, end: 115 }]);
    const timestamps = [0, 5, 10, 14, 15];
    const coverage = view.coverage;
    assert.deepEqual(timestamps.filter(time => coverage.some(range => time >= range.start && time < range.end)), [0, 10, 14]);
    assert.equal(local.rebaseValue(110), 10);
    assert.equal(local.resolveValue(10), 110);
    assert.deepEqual(selection.ranges, [{ start: 95, end: 105 }, { start: 110, end: 115 }]);
});
