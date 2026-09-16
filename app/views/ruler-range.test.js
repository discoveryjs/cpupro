import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createState, createSelectionState, moveState, resizeState } from './ruler-range.js';

describe('ruler ranges', () => {
    for (const duration of [11, 1000, 4960851]) {
        test(`preserves exact ranges across segment grids, duration=${duration}`, () => {
            const start = Math.round(duration * 0.13);
            const end = Math.round(duration * 0.67);
            for (const segments of [null, 7, 10, 500, 1432, 2000]) {
                const state = createState(duration, segments, start, end);
                assert.equal(state.timeStart, start);
                assert.equal(state.timeEnd, end);
                assert.deepEqual(createState(duration, segments, state.timeStart, state.timeEnd), state);
            }
        });

        test(`preserves span during translation and boundary clamping, duration=${duration}`, () => {
            const start = Math.round(duration * 0.13);
            const end = Math.round(duration * 0.67);
            for (const segments of [null, 10, 500, 1432]) {
                const initial = createState(duration, segments, start, end);
                for (const delta of [-2, -0.01, 0, 0.137, 2]) {
                    const moved = moveState(duration, segments, initial, delta);
                    assert.equal(moved.timeEnd - moved.timeStart, end - start);
                    assert.ok(moved.timeStart >= 0 && moved.timeEnd <= duration);
                }
                assert.deepEqual(moveState(duration, segments, initial, 0), initial);
            }
        });
    }

    test.each([11, 1001, 4960851])('uses contiguous half-open segment boundaries for duration=%i', duration => {
        for (let index = 0; index < 10; index++) {
            const cell = createSelectionState(duration, 10, (index + 0.25) / 10, (index + 0.25) / 10);
            assert.equal(cell.segmentStart, index);
            assert.equal(cell.segmentEnd, index);
            if (index + 1 < 10) {
                const next = createSelectionState(duration, 10, (index + 1.25) / 10, (index + 1.25) / 10);
                assert.equal(cell.timeEnd, next.timeStart);
            }
        }
        assert.equal(createState(100, 10, 20, 30).segmentEnd, 2);
        assert.equal(createState(100, 10, 20, 20).timeEnd, 20);
    });

    test('selects the same range in either direction', () => {
        assert.deepEqual(createSelectionState(1000, 10, 0.2, 0.7), createSelectionState(1000, 10, 0.7, 0.2));
    });

    test('resizes only the pointer endpoint', () => {
        const state = resizeState(1000, 10, 123, 0.49);
        assert.equal(state.timeStart, 123);
        assert.equal(state.timeEnd, 500);
    });

    test('has no selection for an empty axis', () => {
        assert.equal(createState(0, 10, 0, 0).start, null);
    });
});
