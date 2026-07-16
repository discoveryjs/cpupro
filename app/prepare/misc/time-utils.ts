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

export function formatMicrosecondsTime(time: number, duration: number, fixed = false) {
    time = Math.round(time);

    const m = Math.floor(time / (60 * 1000 * 1000));
    const s = Math.floor(time / (1000 * 1000)) % 60;
    const ms = Math.floor(time / 1000) % 1000;
    // const ns = time % 1000;

    // console.log({ m, s, ms, ns, duration, time, timeRulerStep });

    switch (true) {
        case duration < 100_000: {
            return `${(time / 1000).toFixed(1)}ms`;
        }

        case duration < 1_000_000: {
            return `${Math.floor(time / 1000)}ms`;
        }

        case duration < 60_000_000: {
            const text = `${s}.${padZeroLeft(ms, 3)}s`;
            return fixed ? text : text.replace(/(\.000|0+)s/, 's');
        }

        default: {
            const text = `${m}:${padZeroLeft(s, 2)}.${padZeroLeft(ms, 3)}`;
            return fixed ? text : text.replace(/(\.000|0+)$/, '');
        }
    }
}
