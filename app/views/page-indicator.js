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
