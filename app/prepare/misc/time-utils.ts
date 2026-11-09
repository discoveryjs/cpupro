function padZeroLeft(n: number, d: number) {
    return String(n).padStart(d, '0');
}

export const now = typeof performance !== 'undefined' && performance.now
    ? performance.now.bind(performance)
    : Date.now.bind(Date);
export const perfMeasure: typeof performance.measure = typeof performance !== 'undefined' && performance.measure
    ? performance.measure.bind(performance)
    : () => {};
export const perfMark: typeof performance.mark = typeof performance !== 'undefined' && performance.mark
    ? performance.mark.bind(performance)
    : () => {};

// Fraction digits showing a step of a ruler exactly in a unit, e.g. 2 for a step of 0.25
export function stepFractionDigits(step: number, unit: number) {
    let digits = 0;

    for (let value = step / unit; digits < 6 && Math.abs(value - Math.round(value)) > value * 1e-9; value *= 10) {
        digits++;
    }

    return digits;
}

// The unit follows the duration of a whole scale. A step of the scale, as a step of ruler markers within a zoomed range,
// gives the fraction digits of the unit that tell steps apart rather than a smaller unit
export function formatMicrosecondsTime(time: number, duration: number, fixed = false, step?: number) {
    if (duration < 1_000_000) {
        // Ruler steps are about a tenth of the duration, a digit more is needed for each tenfold shorter one
        const digits = step !== undefined
            ? stepFractionDigits(step, 1000)
            : duration < 100_000 ? Math.max(1, Math.ceil(Math.log10(10_000 / duration)) + 1) : 0;

        return `${(time / 1000).toFixed(digits)}ms`;
    }

    // Seconds show whole microseconds at most
    const microseconds = Math.round(time);
    const seconds = Math.floor(microseconds / (1000 * 1000)) % 60;
    const fraction = secondFraction(microseconds, fixed, step);

    return duration < 60_000_000
        ? `${seconds}${fraction}s`
        : `${Math.floor(microseconds / (60 * 1000 * 1000))}:${padZeroLeft(seconds, 2)}${fraction}`;
}

// Milliseconds of a second unless they are zero, or the digits of a step
function secondFraction(time: number, fixed: boolean, step?: number) {
    const digits = step !== undefined ? stepFractionDigits(step, 1000 * 1000) : 3;
    const fraction = padZeroLeft(time % (1000 * 1000), 6).slice(0, digits);

    const shown = step !== undefined || fixed ? fraction : fraction.replace(/0+$/, '');

    return shown && '.' + shown;
}
