import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatMicrosecondsTime } from './time-utils.js';

test('formats time in the unit and precision of a duration', () => {
    assert.equal(formatMicrosecondsTime(2_420_275, 60_000_000), '0:02.42');
    assert.equal(formatMicrosecondsTime(2_420_275, 5_000_000), '2.42s');
    assert.equal(formatMicrosecondsTime(2_420_275, 500_000), '2420ms');
    assert.equal(formatMicrosecondsTime(2_420_275, 50_000), '2420.3ms');
    assert.equal(formatMicrosecondsTime(2_420_275, 10_000), '2420.3ms');
    assert.equal(formatMicrosecondsTime(2_420_275, 5_000), '2420.28ms');
    assert.equal(formatMicrosecondsTime(2_420_275, 336), '2420.275ms');
    assert.equal(formatMicrosecondsTime(2_420_275, 30), '2420.2750ms');
});

test('ruler steps of a short duration keep distinct labels', () => {
    for (const [duration, step] of [[336, 25], [1000, 100], [3000, 500], [80, 5], [8, 1]]) {
        const labels = new Set();

        for (let time = 0; time < duration; time += step) {
            labels.add(formatMicrosecondsTime(2_420_000 + time, duration));
        }

        assert.equal(labels.size, Math.ceil(duration / step));
    }
});
