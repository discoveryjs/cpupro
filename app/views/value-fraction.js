import { utils } from '@discoveryjs/discovery';

discovery.view.define('value-fraction', function(el, { value, unit, total, fraction }) {
    const valueEl = document.createElement('span');
    const match = unit ? null : String(value).match(/^([+-]?\d+(?:\.\d+(?:e[+-]?\d+)?)?)\s*(\S+)?$/);
    const normValue = match?.[1] || value;
    const normUnit = match?.[2] || unit;

    valueEl.className = 'value';
    valueEl.innerHTML = utils.numDelim(normValue);

    if (normUnit) {
        valueEl.dataset.unit = normUnit;
    }

    el.append(valueEl);

    const fractionEl = document.createElement('span');
    const normFraction = Number.isFinite(fraction) ? 100 * fraction : 100 * normValue / total;

    fractionEl.className = 'fraction';
    fractionEl.innerText = normFraction === 0
        ? ''
        : normFraction < 0.1
            ? '<0.1%'
            : normFraction >= 99.9
                ? Math.round(normFraction) + '%'
                : normFraction.toFixed(1) + '%';

    el.append(fractionEl);
});
