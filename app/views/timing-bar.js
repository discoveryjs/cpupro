const colors = [
    '#f98e94',
    '#fcb69a',
    '#fee29c',
    '#edfdd1',
    '#c5fccf',
    '#7dfacd',
    '#8db2f8',
    '#4688f8'
];

discovery.view.define('timing-bar', function(el, config, data) {
    if (!Array.isArray(data)) {
        data = [data];
    }

    let total = 0;
    const entries = data
        .map(entry => {
            let { duration = 0, ...rest } = entry || {};

            if (!isFinite(duration)) {
                duration = 0;
            }

            total += duration;

            return { duration, ...rest };
        })
        .filter(entry => entry.duration > 0)
        .sort((a, b) => b.duration - a.duration);

    let idx = 0;
    for (const { text = '?', duration, href } of entries) {
        const chunkEl = document.createElement('a');

        chunkEl.className = 'view-timing-bar__segment';
        chunkEl.style.setProperty('--fraction', duration / total);
        chunkEl.style.setProperty('--color', colors[idx++] + '70');
        chunkEl.title =
        chunkEl.innerText = `${text} (${(duration / 1000).toFixed(1)}ms / ${(100 * duration / total).toFixed(1)}%)`;

        if (href) {
            chunkEl.href = href;
        }

        el.append(chunkEl);
    }
});
