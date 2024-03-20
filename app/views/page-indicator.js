function ensureArray(value) {
    return Array.isArray(value) ? value : value ? [value] : [];
}

discovery.view.define('page-indicators', function(el, config, data, context) {
    const content = ensureArray(this.normalizeConfig(config.content));
    const normalizedContent = [];
    let lastGroup = null;

    for (let item of content) {
        if (item.view === 'page-indicator-group') {
            normalizedContent.push(lastGroup = {
                ...item,
                content: ensureArray(item.content)
            });
        } else {
            if (lastGroup === null) {
                normalizedContent.push(lastGroup = {
                    view: 'page-indicator-group',
                    content: []
                });
            }

            lastGroup.content.push(item);
        }
    }

    return this.render(el, normalizedContent, data, context);
});

discovery.view.define('page-indicator-group', function(el, config, data, context) {
    const content = ensureArray(this.normalizeConfig(config.content)).map(item => ({
        view: 'page-indicator',
        ...item
    }));

    return this.render(el, content, data, context);
});

discovery.view.define('page-indicator', function(el, config, data, context) {
    const { title, value, unit, content } = config;

    const titleEl = document.createElement('span');
    const valueEl = document.createElement('span');
    const valueText = unit === true ? String(value).replace(/[^\d]+$/, '') : value;

    titleEl.className = 'title';
    valueEl.className = 'value';

    titleEl.textContent = title;

    if (content) {
        discovery.view.render(valueEl, content, data, context);
    } else {
        discovery.view.render(valueEl, 'text-numeric', valueText, context);
    }

    if (unit) {
        const unitEl = document.createElement('span');

        unitEl.className = 'unit';
        unitEl.textContent = unit === true ? String(value).slice(String(value).replace(/[^\d]+$/, '').length) : unit;

        valueEl.append(unitEl);
    }

    el.append(titleEl, valueEl);
});
