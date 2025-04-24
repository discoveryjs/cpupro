import { vmFunctionStateTiers } from '../prepare/const.js';

discovery.view.define('code-tier-badge', function(el, config, data) {
    let { tier = data, count } = config;

    if (!vmFunctionStateTiers.includes(tier)) {
        tier = 'Unknown';
    }

    const { abbr, color } = discovery.query('{ abbr(), color() }', tier);

    el.style.setProperty('--color', color);
    el.dataset.tier = tier;
    el.textContent = abbr;

    if (count) {
        el.dataset.count = count;
    }
});
