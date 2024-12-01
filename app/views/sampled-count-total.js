import { createElement } from '@discoveryjs/discovery/utils';

discovery.view.define('sampled-count-total', function(el, config, data, context) {
    const {
        hideZeroCount,
        count,
        countConfig = 'text-numeric',
        total,
        totalConfig = 'text-numeric'
    } = config;
    const countEl = createElement('span', 'count');
    const totalEl = createElement('span', 'total');

    if (hideZeroCount && !count) {
        el.classList.add('no-sampled');
    }

    el.append(countEl, createElement('span', 'divider'), totalEl);

    return Promise.all([
        this.render(countEl, countConfig, count, context),
        this.render(totalEl, totalConfig, total, context)
    ]);
}, { tag: 'span' });
