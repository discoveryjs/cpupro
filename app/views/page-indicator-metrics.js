function hint(metric) {
    return {
        view: 'markdown',
        data: '{ ..., metric: "' + metric + '" }',
        source: '#### {{metric.metricName()}}\n\n' +
            '{{metric.metricDefinition()}}\n\n' +
            'For modules, packages, or categories, it represents the accumulated value for all functions that belong to them.\n\n' +
            'A `Filtered` badge indicates that the displayed value represents only a portion of the total value, due to a selected range on the timeline.'
    };
}

function hintPercent(metric) {
    return {
        view: 'markdown',
        data: '{ ..., metric: "' + metric + '" }',
        source: '#### {{metric.metricName()}}, %\n\n' +
            'Represents the proportion of the total duration of a profiling session.\n\n' +
            '`100%` × `{{filtered[metric] | unit()}}` ⁄ `{{scopeLine().axisTotal | unit()}}` = `{{filtered[metric] | totalMetricPercent(2)}}`'
    };
}

discovery.view.define('page-indicator-metrics', {
    view: 'page-indicator-group',
    className: 'view-page-indicator-metrics',
    content: [
        {
            title: '="selfValue".metricName()',
            hint: hint('selfValue'),
            content: [
                { view: 'text-with-unit', value: '=filtered.selfValue | ? unit() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.selfValue | ? unit() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.selfValue != full.selfValue',
                content: 'text:"filtered"'
            }
        },
        {
            title: '=`${"selfValue".metricName()}, %`',
            hint: hintPercent('selfValue'),
            value: '=filtered.selfValue | ? totalMetricPercent() : "—"',
            unit: true
        },
        {
            title: '="nestedValue".metricName()',
            hint: hint('nestedValue'),
            content: [
                { view: 'text-with-unit', value: '=filtered.nestedValue | ? unit() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.nestedValue | ? unit() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.nestedValue != full.nestedValue',
                content: 'text:"filtered"'
            }
        },
        {
            title: '=`${"nestedValue".metricName()}, %`',
            hint: hintPercent('nestedValue'),
            value: '=filtered.nestedValue | ? totalMetricPercent() : "—"',
            unit: true
        },
        {
            title: '="totalValue".metricName()',
            hint: hint('totalValue'),
            content: [
                { view: 'text-with-unit', value: '=filtered.totalValue | ? unit() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.totalValue | ? unit() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.totalValue != full.totalValue',
                content: 'text:"filtered"'
            }
        },
        {
            title: '=`${"totalValue".metricName()}, %`',
            hint: hintPercent('totalValue'),
            value: '=filtered.totalValue | ? totalMetricPercent() : "—"',
            unit: true
        }
    ]
}, { tag: false });
