const { createElement } = require('@discoveryjs/discovery/utils');

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
    const { title, value, unit, annotation, content, hint } = config;

    const titleEl = createElement('span', 'title', title);
    const valueEl = createElement('span', 'value');

    if (content) {
        discovery.view.render(valueEl, content, data, context);
    } else {
        discovery.view.render(valueEl, { view: 'text-with-unit', value, unit, content }, data, context);
    }

    el.append(titleEl, valueEl);

    if (hint) {
        const hintEl = createElement('span', 'hint');

        this.tooltip(hintEl, {
            showDelay: true,
            className: 'hint-tooltip',
            ...typeof hint === 'object' && !Array.isArray(hint) && !hint.view
                ? hint
                : { content: hint }
        }, data, context);
        el.append(hintEl);
    }

    if (annotation) {
        const annotationEl = createElement('span', 'annotation');

        this.render(annotationEl, annotation, data, context);
        el.append(annotationEl);
    }
});
