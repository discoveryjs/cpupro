import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixTimeDeltasOrderIfNeeded } from './time-deltas.js';

test('moves samples, script offsets and allocation ids together when deltas are out of order', () => {
    const timeDeltas = [10, 20, -5, 7];
    const samples = [1, 2, 3, 4];
    const offsets = [11, 22, 33, 44];
    const mapping = [1, 4, 2, 5];

    fixTimeDeltasOrderIfNeeded(timeDeltas, samples, offsets, mapping);

    assert.deepEqual(timeDeltas, [10, 15, 5, 2]);
    assert.deepEqual(samples, [1, 3, 2, 4]);
    assert.deepEqual(offsets, [11, 33, 22, 44]);
    assert.deepEqual(mapping, [1, 2, 4, 5]);
});

test('re-evaluates the previous sample after a swap when several samples are out of order', () => {
    const timeDeltas = [10, 5, -8, -3];
    const samples = [1, 2, 3, 4];
    const mapping = [1, 5, 3, 2];

    fixTimeDeltasOrderIfNeeded(timeDeltas, samples, null, mapping);

    assert.ok(timeDeltas.every(delta => delta >= 0));
    assert.deepEqual(samples.slice().sort(), [1, 2, 3, 4]);
    assert.deepEqual(mapping, samples.map(sample => [1, 5, 3, 2][sample - 1]));
});

test('keeps ordered input intact and tolerates a mapping shorter than samples', () => {
    const timeDeltas = [4, 6, 8];
    const samples = [1, 2, 3];
    const mapping = [2, 3];

    fixTimeDeltasOrderIfNeeded(timeDeltas, samples, null, mapping);

    assert.deepEqual(timeDeltas, [4, 6, 8]);
    assert.deepEqual(samples, [1, 2, 3]);
    assert.deepEqual(mapping, [2, 3]);

    const shortMapping = [3];
    const shortSamples = [1, 2];

    fixTimeDeltasOrderIfNeeded([5, -1], shortSamples, null, shortMapping);

    assert.deepEqual(shortSamples, [2, 1]);
    assert.deepEqual(shortMapping, [3]);
});
