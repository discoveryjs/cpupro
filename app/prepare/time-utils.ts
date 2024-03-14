function padZeroLeft(n: number, d: number) {
    return String(n).padStart(d, '0');
}

export function formatMicrosecondsTime(time: number, duration: number) {
    time = Math.round(time);

    const m = Math.floor(time / (60 * 1000 * 1000));
    const s = Math.floor(time / (1000 * 1000)) % 60;
    const ms = Math.floor(time / 1000) % 1000;
    // const ns = time % 1000;

    // console.log({ m, s, ms, ns, duration, time, timeRulerStep });

    switch (true) {
        case duration < 100_000:
            return `${(time / 1000).toFixed(1)}ms`;

        case duration < 1_000_000:
            return `${Math.floor(time / 1000)}ms`;

        case duration < 60_000_000:
            return `${s}.${padZeroLeft(ms, 3)}s`.replace(/(\.000|0+)s/, 's');

        default:
            return `${m}:${padZeroLeft(s, 2)}.${padZeroLeft(ms, 3)}`.replace(/(\.000|0+)$/, '');
    }
}
