import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatMicrosecondsTime, stepFractionDigits } from './time-utils.js';

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

test('a step keeps the unit of a duration and gives the fraction digits telling steps apart', () => {
    assert.deepEqual([1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.0001].map(step => stepFractionDigits(step * 1000, 1000)), [0, 1, 2, 1, 2, 3, 4]);
    assert.equal(stepFractionDigits(3_000_000, 1_000_000), 0);

    // Seconds of a 30 s scale stay seconds within a zoomed millisecond
    assert.equal(formatMicrosecondsTime(10_000_000, 30_000_000, false, 5_000_000), '10s');
    assert.equal(formatMicrosecondsTime(10_000_000, 30_000_000, false, 250_000), '10.00s');
    assert.equal(formatMicrosecondsTime(10_250_000, 30_000_000, false, 250_000), '10.25s');
    assert.equal(formatMicrosecondsTime(10_000_500, 30_000_000, false, 500), '10.0005s');
    assert.equal(formatMicrosecondsTime(10_000_003, 30_000_000, false, 1), '10.000003s');

    // Minutes and milliseconds alike
    assert.equal(formatMicrosecondsTime(90_000_000, 600_000_000, false, 60_000_000), '1:30');
    assert.equal(formatMicrosecondsTime(90_125_000, 600_000_000, false, 25_000), '1:30.125');
    assert.equal(formatMicrosecondsTime(250_000, 500_000, false, 50_000), '250ms');
    assert.equal(formatMicrosecondsTime(250_050, 500_000, false, 25), '250.050ms');
});

test('without a step seconds and minutes show milliseconds unless they are zero, or always when fixed', () => {
    assert.equal(formatMicrosecondsTime(10_000_000, 30_000_000), '10s');
    assert.equal(formatMicrosecondsTime(10_500_000, 30_000_000), '10.5s');
    assert.equal(formatMicrosecondsTime(10_050_000, 30_000_000), '10.05s');
    assert.equal(formatMicrosecondsTime(10_000_000, 30_000_000, true), '10.000s');
    assert.equal(formatMicrosecondsTime(90_000_000, 600_000_000), '1:30');
    assert.equal(formatMicrosecondsTime(90_500_000, 600_000_000), '1:30.5');
    assert.equal(formatMicrosecondsTime(2_420_275, NaN, true), '0:02.420');
});
