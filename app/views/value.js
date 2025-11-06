import { numDelim } from '@discoveryjs/discovery/utils';
import { resolveScopeProfileLine } from '../jora/profile.js';

function totalPercent(value, total, prec = 2) {
    const percent = 100 * value / total;
    const min = 1 / Math.pow(10, prec || 1);
    return percent >= min ? percent.toFixed(prec || 1) + '%' : percent !== 0 ? '<' + min + '%' : '0%';
}

function createRender(slug, getter) {
    return function render(el, config, data, context) {
        const {
            value = typeof data === 'number' ? data : getter(data),
            total = 'line' // number | line | bucket | all-profiles
        } = config;
        const line = resolveScopeProfileLine(config.line, context);
        const valueEl = document.createElement('span');
        const valueWithUnit = value !== 0
            ? line.valueWithUnit(value)
            : { value: '—', unit: '' };

        el.classList.add('view-value');

        valueEl.className = 'value';
        valueEl.dataset.unit = valueWithUnit.unit;
        valueEl.innerHTML = numDelim(valueWithUnit.value);
        el.append(valueEl);

        this.tooltip(el, {
            showDelay: true,
            className: 'cpupro-hint-tooltip',
            content: 'md{ source: `#### ${metric.metricName(line)}\\n\\n${metric.metricDefinition(line)}` }'
        }, { metric: slug, line }, context);

        if (value) {
            const fractionEl = document.createElement('span');
            fractionEl.className = 'fraction';
            fractionEl.append(totalPercent(value, typeof total === 'number'
                ? total
                : line.axisTotal // FIXME: support 'bucket' and 'all-profiles'
            ));
            el.append(fractionEl);
        }
    };
}

discovery.view.define('self-value', createRender('selfValue', data => data?.selfValue), { tag: 'span' });
discovery.view.define('nested-value', createRender('nestedValue', data => data?.totalValue - data?.selfValue), { tag: 'span' });
discovery.view.define('total-value', createRender('totalValue', data => data?.totalValue), { tag: 'span' });
