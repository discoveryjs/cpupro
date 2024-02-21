function pad(n, d) {
    return String(n).padStart(d, '0');
}

function base(n) {
    let b = 1;

    while (n > 10) {
        b *= 10;
        n = Math.floor(n / 10);
    }

    return n > 5 ? b : n >= 2.5 ? b / 2 : b / 4;
}

discovery.view.define('time-ruler', (el, config) => {
    const { duration, captions } = config;
    const timeRulerStep = base(duration);

    switch (captions) {
        case 'top':
        case 'bottom':
            el.classList.add(captions);
            break;

        case 'both':
            el.classList.add('top', 'bottom');
            break;
    }

    for (
        let time = 0;
        time < duration - timeRulerStep / 10;
        time += timeRulerStep
    ) {
        const lineEl = el.appendChild(document.createElement('div'));
        const m = Math.floor(time / (60 * 1000 * 1000));
        const s = Math.floor(time / (1000 * 1000)) % 60;
        const ms = Math.floor(time / 1000) % 1000;
        // const ns = time % 1000;

        // console.log({ m, s, ms, ns, duration, time, timeRulerStep });

        lineEl.className = 'line';
        lineEl.style.setProperty('--offset', time / duration);
        lineEl.dataset.title =
            duration < 100_000 ? `${(time / 1000).toFixed(1)}ms`
                : duration < 1_000_000 ? `${Math.floor(time / 1000)}ms`
                    : duration < 60_000_000 ? `${s}.${pad(ms, 3)}s`.replace(/(\.000|0+)s/, 's')
                        : `${m}:${pad(s, 2)}.${pad(ms, 3)}`.replace(/(\.000|0+)$/, '');
    }
});
