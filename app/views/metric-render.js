import { numDelim, createElement } from '@discoveryjs/discovery/utils';
import { resolveScopeProfileLine } from '../jora/profile.ts';

export function renderMetricView(el, config, data, context) {
    const { value, total = 'line', metricName } = typeof data === 'number' ? { value: data } : data || { value: '?' };
    const line = resolveScopeProfileLine(config.line, context);
    const valueEl = createElement('span', 'value');
    const valueWithUnit = line.valueWithUnit(value);
    const resolvedTotal = typeof total === 'number'
        ? total
        : total === 'line'
            ? line.axisTotal
            : 0; // TODO: support 'bucket' and 'all-profiles'

    valueEl.dataset.unit = valueWithUnit.unit;
    valueEl.classList.add(line.type);
    valueEl.innerHTML = numDelim(valueWithUnit.value);

    if (metricName) {
        el.dataset.metricName = line.metricName(metricName);
    }

    el.append(valueEl);

    if (resolvedTotal) {
        const fractionEl = document.createElement('span');
        const fraction = 100 * value / resolvedTotal;

        fractionEl.className = 'fraction';
        fractionEl.innerText = fraction === 0
            ? ''
            : fraction < 0.1
                ? '<0.1%'
                : fraction >= 99.9
                    ? Math.round(fraction) + '%'
                    : fraction.toFixed(1) + '%';

        el.append(fractionEl);
    }
}
