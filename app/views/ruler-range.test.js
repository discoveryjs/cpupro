import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createState, normalizeSelection, selectRange, moveRange, resizeRange, zoomRange, panRange, rangeToSegments } from './ruler-range.js';

const irregular = [100, 110, 140, 200];

test.each([100, [0, 100], [100, 0], { start: 0, end: 100 }])('a scale of %o is the range from 0 to 100', range => {
    assert.deepEqual(createState(range), { range: { start: 0, end: 100 }, length: 100, segments: null, selection: null });
});

test.each([
    [[10, 11], 4, [10, 10.25, 10.5, 10.75, 11]],
    [[100, 200], 1, [100, 200]],
    [[100, 200], 2.5, [100, 150, 200]],
    [[100, 200], 0, null],
    [[100, 200], 0.5, null],
    [[100, 200], -1, null],
    [[100, 200], irregular, irregular],
    [[100, 200], [100, 140, 140, 200], null],
    [[100, 200], [100, 150, 140, 200], null],
    [[100, 200], [100, 110, 140], null],
    [[110, 200], irregular, null],
    [0, 10, null]
])('a scale of %o with segments %o has the boundaries %o', (range, segments, expected) => {
    assert.deepEqual(createState(range, segments).segments, expected);
});

test('supplied boundaries are copied', () => {
    const boundaries = irregular.slice();

    assert.notEqual(createState([100, 200], boundaries).segments, boundaries);
});

test.each([
    [null, false, null],
    [null, true, null],
    [[], true, []],
    [{ start: 120, end: 90 }, false, { start: 90, end: 120 }],
    [[{ start: 120, end: 90 }], true, [{ start: 90, end: 120 }]],
    [[{ start: 90, end: 120 }, { start: 115, end: 130 }, { start: 210, end: 230 }], true, [{ start: 90, end: 130 }, { start: 210, end: 230 }]],
    [[{ start: 210, end: 230 }, { start: 115, end: 130 }, { start: 90, end: 120 }], true, [{ start: 90, end: 130 }, { start: 210, end: 230 }]],
    [[{ start: 100, end: 130 }, { start: 110, end: 120 }], true, [{ start: 100, end: 130 }]],
    // Touching ranges merge as in a range manager, so an echo of a written selection is equal to it
    [[{ start: 100, end: 110 }, { start: 110, end: 120 }], true, [{ start: 100, end: 120 }]]
])('a selection %o, multiple=%s is normalized to %o', (selection, multiple, expected) => {
    assert.deepEqual(normalizeSelection(selection, multiple), expected);
});

test('normalizing a multiple selection leaves the external one intact', () => {
    const selection = [{ start: 115, end: 130 }, { start: 90, end: 120 }];

    normalizeSelection(selection, true);
    assert.deepEqual(selection, [{ start: 115, end: 130 }, { start: 90, end: 120 }]);
});

test('a selection is single by default', () => {
    assert.deepEqual(createState(1000, 10, { start: 670, end: 130 }).selection, { start: 130, end: 670 });
});

test.each([null, 7, 1432])('external selections stay unsnapped and unclipped on a scale with segments=%s', segments => {
    const selection = [{ start: 130, end: 670 }, { start: 990, end: 1200 }, { start: 1300, end: 1300 }];
    const state = createState(1000, segments, selection, true);

    assert.deepEqual(state.selection, selection);
    assert.deepEqual(createState(1000, segments, state.selection, true), state);
});

test.each([
    [{ start: 110, end: 140 }, irregular, { start: 1, end: 2 }],
    [{ start: 90, end: 120 }, irregular, { start: 0, end: 2 }],
    [{ start: 150, end: 250 }, irregular, { start: 2, end: 3 }],
    [{ start: 110, end: 110 }, irregular, { start: 1, end: 2 }],
    [{ start: 100, end: 100 }, irregular, { start: 0, end: 1 }],
    [{ start: 20, end: 30 }, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], { start: 2, end: 3 }],
    [{ start: 50, end: 90 }, irregular, null],
    [{ start: 80, end: 100 }, irregular, null],
    [{ start: 200, end: 200 }, irregular, null],
    [{ start: 200, end: 220 }, irregular, null],
    [{ start: 110, end: 120 }, null, null]
])('a range %o covers the half-open segments of %o at %o', (range, segments, expected) => {
    assert.deepEqual(rangeToSegments(range, segments), expected);
});

test.each([11, 1001, 4960851])('a point in each of 10 uniform segments over %i selects that segment', duration => {
    const state = createState(duration, 10);

    for (let i = 0; i < 10; i++) {
        const fraction = (i + 0.25) / 10;
        const cell = selectRange(state, fraction, fraction);

        assert.deepEqual(cell, { start: state.segments[i], end: state.segments[i + 1] });
        assert.deepEqual(rangeToSegments(cell, state.segments), { start: i, end: i + 1 });
    }
});

test.each([
    [[-1, 1], null, 0.25, 0.625, { start: -0.5, end: 0.25 }],
    [[-1, 1], null, 0.625, 0.25, { start: -0.5, end: 0.25 }],
    [[-1, 1], null, 0.25, 0.25, { start: -0.5, end: -0.5 }],
    [[10, 11], 4, 0.1, 0.6, { start: 10, end: 10.75 }],
    [1000, 10, 0.7, 0.2, { start: 200, end: 700 }],
    [[100, 200], irregular, 0.15, 0.15, { start: 110, end: 140 }],
    [[100, 200], irregular, 1, 1, { start: 140, end: 200 }]
])('on a scale of %o with segments %o a selection from %s to %s is %o', (range, segments, anchor, pointer, expected) => {
    assert.deepEqual(selectRange(createState(range, segments), anchor, pointer), expected);
});

test.each([
    [[-1, 1], null, { start: -0.5, end: 0.25 }, 0.125, { start: -0.25, end: 0.5 }],
    [[-1, 1], null, { start: -0.5, end: 0.25 }, 5, { start: 0.25, end: 1 }],
    [[-1, 1], null, { start: -0.5, end: 0.25 }, -5, { start: -1, end: -0.25 }],
    // On segments the start moves to the boundary nearest to the moved start, an unmoved one stays off the grid
    [[100, 200], 10, { start: 123, end: 167 }, 0.15, { start: 140, end: 184 }],
    [1000, 10, { start: 130, end: 670 }, 0.137, { start: 300, end: 840 }],
    [1000, 10, { start: 130, end: 670 }, -0.01, { start: 100, end: 640 }],
    [1000, 10, { start: 130, end: 670 }, 0, { start: 130, end: 670 }],
    [1000, 10, { start: 130, end: 670 }, 2, { start: 460, end: 1000 }],
    [1000, 10, { start: 130, end: 670 }, -2, { start: 0, end: 540 }]
])('on a scale of %o with segments %o %o moved by %s is %o', (range, segments, selection, delta, expected) => {
    assert.deepEqual(moveRange(createState(range, segments), selection, delta), expected);
});

// Rows: anchor, pointer fraction, minimum, direction at the anchor, expected range
test.each([
    [140, 0.4, 1, -1, { start: 110, end: 140 }],
    [140, 0.4, 1, 1, { start: 140, end: 200 }],
    [140, 0.39, 1, 1, { start: 110, end: 140 }],
    [140, 0.41, 1, -1, { start: 140, end: 200 }],
    [100, 0, 1, -1, { start: 100, end: 110 }],
    [200, 1, 1, 1, { start: 140, end: 200 }],
    [123, 0.23, 1, -1, { start: 110, end: 123 }],
    [123, 0.23, 1, 1, { start: 123, end: 140 }],
    [110, 0.35, 0, 1, { start: 110, end: 140 }]
])('on irregular segments a resize from %s to %s stops at a distinct boundary, minimum=%s, direction=%s', (anchor, pointer, minimum, direction, expected) => {
    assert.deepEqual(resizeRange(createState([100, 200], irregular), anchor, pointer, minimum, direction), expected);
});

test.each([
    [[10, 11], 4, 10.1, 0.6, { start: 10.1, end: 10.5 }],
    [1000, 10, 123, 0.49, { start: 123, end: 500 }]
])('on a scale of %o with uniform segments %s a resize of an off-grid anchor %s to %s is %o', (range, segments, anchor, pointer, expected) => {
    assert.deepEqual(resizeRange(createState(range, segments), anchor, pointer), expected);
});

// The scale is [-1, 1]; rows: anchor, pointer fraction, minimum, direction at the anchor, expected range
test.each([
    [0, 0.5, 0.25, -1, { start: -0.25, end: 0 }],
    [0, 0.5, 0.25, 1, { start: 0, end: 0.25 }],
    [0, 0.49, 0.25, 1, { start: -0.25, end: 0 }],
    [0, 0.51, 0.25, -1, { start: 0, end: 0.25 }],
    [-1, 0, 0.25, -1, { start: -1, end: -0.75 }],
    [1, 1, 0.25, 1, { start: 0.75, end: 1 }],
    [0, 0.5, 0, 1, { start: 0, end: 0 }],
    [-0.5, 0.625, 0, 1, { start: -0.5, end: 0.25 }]
])('on a continuous scale a resize from %s to %s keeps the minimum %s, direction=%s', (anchor, pointer, minimum, direction, expected) => {
    assert.deepEqual(resizeRange(createState([-1, 1]), anchor, pointer, minimum, direction), expected);
});

test.each([
    [{ start: 20, end: 60 }, { start: 0, end: 100 }, 0.25, 0.5, 0, { start: 25, end: 45 }],
    [{ start: 20, end: 60 }, { start: 0, end: 100 }, 0, 0.5, 0, { start: 20, end: 40 }],
    [{ start: 20, end: 60 }, { start: 0, end: 100 }, 1, 2, 0, { start: 0, end: 80 }],
    [{ start: 20, end: 60 }, { start: 0, end: 100 }, 0.5, 4, 0, { start: 0, end: 100 }],
    [{ start: 20, end: 60 }, { start: 10, end: 110 }, 0.5, 4, 0, { start: 10, end: 110 }],
    [{ start: 80, end: 100 }, { start: 0, end: 100 }, 0, 2, 0, { start: 60, end: 100 }],
    [{ start: 20, end: 60 }, { start: 0, end: 100 }, 0.5, 0.01, 2, { start: 39, end: 41 }],
    [{ start: 39, end: 41 }, { start: 0, end: 100 }, 0.5, 0.5, 2, { start: 39, end: 41 }]
])('%o zoomed within %o at %s by %s with a minimum length of %s is %o', (range, bounds, fraction, scale, minimum, expected) => {
    assert.deepEqual(zoomRange(range, bounds, fraction, scale, minimum), expected);
});

test.each([
    [0.5, { start: 0, end: 20 }],
    [-0.25, { start: -15, end: 5 }],
    [10, { start: 30, end: 50 }],
    [-10, { start: -50, end: -30 }]
])('a range from -10 to 10 panned within -50 to 50 by %s is %o', (delta, expected) => {
    assert.deepEqual(panRange({ start: -10, end: 10 }, { start: -50, end: 50 }, delta), expected);
});
