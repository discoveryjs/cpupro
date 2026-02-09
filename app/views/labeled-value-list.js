discovery.view.define('labeled-value-list', function(el, config, data, context) {
    const { kind = 'inline', columns = 1, itemConfig, label, value, limit, emptyText } = config;
    let items = config.items ?? data;
    const composedItemConfig = this.composeConfig('labeled-value',
        this.composeConfig(itemConfig,
            label && value ? { content: label, value } : label ? { content: label } : value ? { value } : undefined
        )
    );

    // 'inline' | 'list' | 'grid'
    el.dataset.kind = kind;
    el.style.setProperty('--column-count', columns);

    if (emptyText !== false && emptyText !== '') {
        el.setAttribute('emptyText', emptyText || 'Empty list');
    }

    if (!Array.isArray(items) && items) {
        items = [items];
    }

    if (Array.isArray(items)) {
        return this.renderList(el, composedItemConfig, items, context, 0, this.listLimit(limit, 25));
    }
});
