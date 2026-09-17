import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createState, normalizeSelection, selectRange, moveRange, resizeRange, rangeToSegments } from './ruler-range.js';

test('normalizes all scale forms and preserves out-of-range selections', () => {
    for (const range of [100, [0, 100], { start: 0, end: 100 }]) {
        assert.deepEqual(createState(range), { range: { start: 0, end: 100 }, length: 100, segments: null, selection: null });
    }
    const selection = [{ start: 90, end: 120 }, { start: 115, end: 130 }, { start: 210, end: 230 }];
    const state = createState([100, 200], 10, selection, true);
    assert.deepEqual(state.selection, [{ start: 90, end: 130 }, { start: 210, end: 230 }]);
    assert.equal(selection.length, 3);
    assert.deepEqual(normalizeSelection([], true), []);
    assert.equal(normalizeSelection(null, true), null);
    assert.deepEqual(normalizeSelection({ start: 120, end: 90 }, false), { start: 90, end: 120 });
    assert.deepEqual(Object.keys(state), ['range', 'length', 'segments', 'selection']);
});

test('continuous gestures retain fractional coordinates and a nonzero origin', () => {
    const state = createState([-1, 1]);
    assert.deepEqual(selectRange(state, 0.25, 0.625), { start: -0.5, end: 0.25 });
    assert.deepEqual(selectRange(state, 0.625, 0.25), selectRange(state, 0.25, 0.625));
    assert.deepEqual(selectRange(state, 0.25, 0.25), { start: -0.5, end: -0.5 });
    assert.deepEqual(moveRange(state, { start: -0.5, end: 0.25 }, 0.125), { start: -0.25, end: 0.5 });
    assert.deepEqual(resizeRange(state, -0.5, 0.625), { start: -0.5, end: 0.25 });
    assert.deepEqual(moveRange(state, { start: -0.5, end: 0.25 }, 5), { start: 0.25, end: 1 });
});

test('supports fractional uniform segments and supplied nonuniform boundaries', () => {
    const state = createState([10, 11], 4);
    assert.deepEqual(state.segments, [10, 10.25, 10.5, 10.75, 11]);
    const segments = state.segments;
    assert.deepEqual(selectRange(state, 0.1, 0.6), { start: 10, end: 10.75 });
    assert.deepEqual(resizeRange(state, 10.1, 0.6), { start: 10.1, end: 10.5 });
    assert.equal(state.segments, segments);
    const boundaries = [100, 110, 140, 200];
    const irregular = createState([100, 200], boundaries);
    assert.notEqual(irregular.segments, boundaries);
    assert.deepEqual(selectRange(irregular, 0.15, 0.15), { start: 110, end: 140 });
    assert.deepEqual(selectRange(irregular, 1, 1), { start: 140, end: 200 });
    assert.deepEqual(resizeRange(irregular, 110, 0.35), { start: 110, end: 140 });
});

test('maps ranges to half-open segment indices independently of selection state', () => {
    const segments = [100, 110, 140, 200];
    assert.deepEqual(rangeToSegments({ start: 110, end: 140 }, segments), { start: 1, end: 2 });
    assert.deepEqual(rangeToSegments({ start: 90, end: 120 }, segments), { start: 0, end: 2 });
    assert.deepEqual(rangeToSegments({ start: 110, end: 110 }, segments), { start: 1, end: 2 });
    assert.equal(rangeToSegments({ start: 80, end: 100 }, segments), null);
    assert.equal(rangeToSegments({ start: 200, end: 220 }, segments), null);
    assert.equal(rangeToSegments({ start: 110, end: 120 }, null), null);
});

test('resizes to a distinct boundary on either side of an irregular grid without moving the anchor', () => {
    const state = createState([100, 200], [100, 110, 140, 200]);
    assert.deepEqual(resizeRange(state, 140, 0.4, 1, -1), { start: 110, end: 140 });
    assert.deepEqual(resizeRange(state, 140, 0.4, 1, 1), { start: 140, end: 200 });
    assert.deepEqual(resizeRange(state, 140, 0.39, 1, 1), { start: 110, end: 140 });
    assert.deepEqual(resizeRange(state, 140, 0.41, 1, -1), { start: 140, end: 200 });
    assert.deepEqual(resizeRange(state, 100, 0, 1, -1), { start: 100, end: 110 });
    assert.deepEqual(resizeRange(state, 200, 1, 1, 1), { start: 140, end: 200 });
    assert.deepEqual(resizeRange(state, 123, 0.23, 1, -1), { start: 110, end: 123 });
    assert.deepEqual(resizeRange(state, 123, 0.23, 1, 1), { start: 123, end: 140 });
});

test('applies the supplied continuous gesture minimum without expanding external points', () => {
    const state = createState([-1, 1]);
    assert.deepEqual(resizeRange(state, 0, 0.5, 0.25, -1), { start: -0.25, end: 0 });
    assert.deepEqual(resizeRange(state, 0, 0.5, 0.25, 1), { start: 0, end: 0.25 });
    assert.deepEqual(resizeRange(state, 0, 0.49, 0.25, 1), { start: -0.25, end: 0 });
    assert.deepEqual(resizeRange(state, 0, 0.51, 0.25, -1), { start: 0, end: 0.25 });
    assert.deepEqual(resizeRange(state, -1, 0, 0.25, -1), { start: -1, end: -0.75 });
    assert.deepEqual(resizeRange(state, 1, 1, 0.25, 1), { start: 0.75, end: 1 });
    assert.deepEqual(resizeRange(state, 0, 0.5), { start: 0, end: 0 });
    assert.deepEqual(createState([-1, 1], 10, { start: 0, end: 0 }).selection, { start: 0, end: 0 });
});

test('keeps exact external spans independent of snapping and handles an empty scale', () => {
    const state = createState(1001, 10, { start: 123, end: 567 });
    for (const delta of [-2, 0, 0.137, 2]) {
        const moved = moveRange(state, state.selection, delta);
        assert.ok(Math.abs(moved.end - moved.start - 444) < 1e-10);
        assert.ok(moved.start >= 0 && moved.end <= 1001);
    }
    assert.deepEqual(moveRange(state, state.selection, 0), state.selection);
    assert.equal(createState(0, 10).segments, null);
});

describe('ruler ranges', () => {
    for (const duration of [11, 1000, 4960851]) {
        test(`preserves exact ranges across segment grids, duration=${duration}`, () => {
            const start = Math.round(duration * 0.13);
            const end = Math.round(duration * 0.67);
            for (const segments of [null, 7, 10, 500, 1432, 2000]) {
                const state = createState(duration, segments, { start, end });
                assert.deepEqual(state.selection, { start, end });
                assert.deepEqual(createState(duration, segments, state.selection), state);
            }
        });

        test(`preserves span during translation and boundary clamping, duration=${duration}`, () => {
            const start = Math.round(duration * 0.13);
            const end = Math.round(duration * 0.67);
            for (const segments of [null, 10, 500, 1432]) {
                const initial = createState(duration, segments, { start, end });
                for (const delta of [-2, -0.01, 0, 0.137, 2]) {
                    const moved = moveRange(initial, initial.selection, delta);
                    assert.ok(Math.abs(moved.end - moved.start - (end - start)) < 1e-8);
                    assert.ok(moved.start >= 0 && moved.end <= duration);
                }
                assert.deepEqual(moveRange(initial, initial.selection, 0), initial.selection);
            }
        });
    }

    test.each([11, 1001, 4960851])('uses contiguous half-open segment boundaries for duration=%i', duration => {
        for (let index = 0; index < 10; index++) {
            const state = createState(duration, 10);
            const cell = selectRange(state, (index + 0.25) / 10, (index + 0.25) / 10);
            assert.deepEqual(rangeToSegments(cell, state.segments), { start: index, end: index + 1 });
            if (index + 1 < 10) {
                const next = selectRange(state, (index + 1.25) / 10, (index + 1.25) / 10);
                assert.equal(cell.end, next.start);
            }
        }
        assert.deepEqual(rangeToSegments({ start: 20, end: 30 }, createState(100, 10).segments), { start: 2, end: 3 });
    });

    test('selects the same range in either direction', () => {
        const state = createState(1000, 10);
        assert.deepEqual(selectRange(state, 0.2, 0.7), selectRange(state, 0.7, 0.2));
    });

    test('resizes only the pointer endpoint', () => {
        assert.deepEqual(resizeRange(createState(1000, 10), 123, 0.49), { start: 123, end: 500 });
    });

    test('has no selection for an empty axis', () => {
        assert.equal(createState(0, 10).selection, null);
    });
});
