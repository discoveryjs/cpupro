discovery.view.define('timing-bar', function(el, config, data, context) {
    const { limit, segment } = config;

    if (!Array.isArray(data)) {
        data = [data];
    }

    const entries = data
        .filter(entry => isFinite(entry.duration) && entry.duration > 0)
        .map((entry, idx) => ({
            ...entry,
            color: entry.color || context.data.colors[idx]
        }));
    const total = entries.reduce((sum, entry) => sum + entry.duration, 0);

    this.renderList(
        el,
        this.composeConfig({ view: 'timing-bar-segment', total }, segment),
        entries,
        context,
        0,
        this.listLimit(limit, 25)
    );
});

discovery.view.define('timing-bar-segment', function(el, config, data) {
    const { total, content } = config;
    const { text = '?', duration, href, color } = data || {};
    const durationText = `${(duration / 1000).toFixed(1)}ms`;
    const durationPercentText = `${(100 * duration / total).toFixed(1)}%`;
    const title = `${text} (${durationText} / ${durationPercentText})`;

    el.style.setProperty('--fraction', duration / total);
    el.style.setProperty('--color', color);

    if (href) {
        el.href = href;
    }

    discovery.view.render(el, content || 'text-numeric:title', { title });

}, { tag: 'a' });
