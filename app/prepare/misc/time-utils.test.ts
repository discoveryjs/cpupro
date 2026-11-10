import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatMicrosecondsTime, stepFractionDigits } from './time-utils.js';

// Below a second of duration, each tenfold shorter duration takes a digit more from 100 ms
test.each([
    [60_000_000, '0:02.42'],
    [5_000_000, '2.42s'],
    [500_000, '2420ms'],
    [100_000, '2420ms'],
    [99_999, '2420.3ms'],
    [10_000, '2420.3ms'],
    [5_000, '2420.28ms'],
    [336, '2420.275ms'],
    [30, '2420.2750ms']
])('2.420275 s in a duration of %i µs is %s', (duration, expected) => {
    assert.equal(formatMicrosecondsTime(2_420_275, duration), expected);
});

test.each([
    [10_000_000, 30_000_000, false, '10s'],
    [10_500_000, 30_000_000, false, '10.5s'],
    [10_050_000, 30_000_000, false, '10.05s'],
    [10_000_000, 30_000_000, true, '10.000s'],
    [90_000_000, 600_000_000, false, '1:30'],
    [90_500_000, 600_000_000, false, '1:30.5'],
    [2_420_275, NaN, true, '0:02.420']
])('without a step %i µs in a duration of %i µs (fixed: %s) is %s', (time, duration, fixed, expected) => {
    assert.equal(formatMicrosecondsTime(time, duration, fixed), expected);
});

test.each([
    [1, 0],
    [0.5, 1],
    [0.25, 2],
    [0.1, 1],
    [0.05, 2],
    [0.025, 3],
    [0.0001, 4],
    [3000, 0],
    // A step that isn't a finite decimal gets at most 6 digits
    [1 / 3, 6]
])('a step of %d units has %i fraction digits', (units, digits) => {
    assert.equal(stepFractionDigits(units * 1000, 1000), digits);
});

// The unit follows the whole scale, a step within a zoomed range gives the fraction digits telling steps apart
test.each([
    [10_000_000, 30_000_000, 5_000_000, '10s'],
    [10_000_000, 30_000_000, 250_000, '10.00s'],
    [10_250_000, 30_000_000, 250_000, '10.25s'],
    [10_000_500, 30_000_000, 500, '10.0005s'],
    [10_000_003, 30_000_000, 1, '10.000003s'],
    [90_000_000, 600_000_000, 60_000_000, '1:30'],
    [90_125_000, 600_000_000, 25_000, '1:30.125'],
    [250_000, 500_000, 50_000, '250ms'],
    [250_050, 500_000, 25, '250.050ms'],
    [2_420_275, 30_000, 1000 / 3, '2420.275000ms']
])('%i µs in a duration of %i µs with a step of %d µs is %s', (time, duration, step, expected) => {
    assert.equal(formatMicrosecondsTime(time, duration, false, step), expected);
});

test.each([
    [336, 25],
    [1000, 100],
    [3000, 500],
    [80, 5],
    [8, 1]
])('ruler steps of %i µs by %i µs keep distinct labels', (duration, step) => {
    const labels = new Set();

    for (let i = 0; i < duration; i += step) {
        labels.add(formatMicrosecondsTime(2_420_000 + i, duration));
    }

    assert.equal(labels.size, Math.ceil(duration / step));
});
