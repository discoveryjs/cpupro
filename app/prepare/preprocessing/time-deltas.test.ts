import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { GeneratedNodes } from './nodes.js';
import { enumerateLongTimeDeltas, fixTimeDeltasOrderIfNeeded, processLongTimeDeltas } from './time-deltas.js';

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

    // Timestamps of samples 1..4 are 10, 15, 7 and 4
    fixTimeDeltasOrderIfNeeded(timeDeltas, samples, null, mapping);

    assert.deepEqual(samples, [4, 3, 1, 2]);
    assert.deepEqual(timeDeltas, [4, 3, 3, 5]);
    assert.deepEqual(mapping, [2, 3, 1, 5]);
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

// A long delta keeps the allowed duration and the rest goes to a "(no samples)" sample after it, which records no
// allocation: it takes the last allocation ID of the sample before it. Samples after the recorded ones have no ID
test.each([
    { name: 'every sample', recorded: [5, 7, 9], expected: [5, 7, 7, 9] },
    { name: 'the samples up to the long one', recorded: [5, 7], expected: [5, 7, 7] },
    { name: 'the samples before the long one', recorded: [5], expected: [5] }
])('moves the last allocation IDs with samples when long deltas are split, recorded by $name', row => {
    const timeDeltas = Uint32Array.of(10, 50, 10, 0);
    const samples = Uint32Array.of(1, 2, 3, 0);
    const generatedNodes = new GeneratedNodes(new Dictionary(), 4);
    const longDeltas = enumerateLongTimeDeltas(10, timeDeltas.subarray(0, 3))!;
    const sampleAllocationIds = processLongTimeDeltas(
        longDeltas,
        timeDeltas,
        samples,
        null,
        Uint32Array.from(row.recorded),
        generatedNodes
    );

    assert.deepEqual([...timeDeltas], [10, 12, 38, 10]);
    assert.deepEqual([...samples], [1, 2, generatedNodes.noSamplesNodeId, 3]);
    assert.deepEqual([...sampleAllocationIds!], row.expected);
});
