discovery.view.define('fractions-bar', function(el, config, data, context) {
    const { limit, segment } = config;

    if (!Array.isArray(data)) {
        data = [data];
    }

    const entries = data.filter(entry => isFinite(entry.value) && entry.value > 0);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);

    return this.renderList(
        el,
        this.composeConfig({ view: 'fractions-bar-segment', total }, segment),
        entries,
        context,
        0,
        this.listLimit(limit, 25)
    );
});

discovery.view.define('fractions-bar-segment', function(el, config, data) {
    const { total, formatValue, content } = config;
    const { text = '?', value, href, color } = data || {};
    const valueText = typeof formatValue === 'function'
        ? formatValue(value, total)
        : value;
    const percentText = `${(100 * value / total).toFixed(1)}%`;
    const title = `${text} - ${valueText} - ${percentText}`;

    el.style.setProperty('--fraction', value / total);
    el.style.setProperty('--color', color);

    if (href) {
        el.href = href;
    }

    return this.render(el, content || 'text-numeric:title', { title });
}, { tag: 'a' });
