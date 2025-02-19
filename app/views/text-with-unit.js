discovery.view.define('text-with-unit', function(el, config, data, context) {
    const { value, unit, content } = config;
    const valueText = unit === true ? String(value).replace(/\D+$/, '') : value;

    if (content) {
        this.render(el, content, data, context);
    } else {
        this.render(el, 'text-numeric', valueText, context);
    }

    if (unit) {
        const unitEl = document.createElement('span');

        unitEl.className = 'unit';
        unitEl.textContent = unit === true ? String(value).slice(valueText.length) : unit;

        el.append(unitEl);
    }
}, { tag: 'span' });
