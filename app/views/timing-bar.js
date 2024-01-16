discovery.view.define('timing-bar', function(el, config, data, context) {
    if (!Array.isArray(data)) {
        data = [data];
    }

    let total = 0;
    const entries = data
        .map(entry => {
            let { duration = 0, ...rest } = entry || {};

            if (!isFinite(duration) || duration < 0) {
                duration = 0;
            }

            total += duration;

            return { duration, ...rest };
        })
        .filter(entry => entry.duration > 0)
        .sort((a, b) => b.duration - a.duration);

    let idx = 0;
    for (const { text = '?', duration, href, color } of entries) {
        const chunkEl = document.createElement('a');
        const durationText = `${(duration / 1000).toFixed(1)}ms`;
        const durationPercentText = `${(100 * duration / total).toFixed(1)}%`;
        const title = `${text} (${durationText} / ${durationPercentText})`;

        chunkEl.className = 'view-timing-bar__segment';
        chunkEl.style.setProperty('--fraction', duration / total);
        chunkEl.style.setProperty('--color', color || context.data.colors[idx++]);
        chunkEl.title = title;

        discovery.view.render(chunkEl, 'text-numeric:title', { title });

        if (href) {
            chunkEl.href = href;
        }

        el.append(chunkEl);
    }
});
