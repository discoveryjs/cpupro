import { createElement } from '@discoveryjs/discovery/utils';

const metrics = [
    { key: 'total', header: 'All lifespans' },
    { key: 'alive', header: 'Alive' },
    { key: 'long-lived', header: 'Long lived' },
    { key: 'short-lived', header: 'Short lived' }
];
const metricView = [
    'text-with-unit{ value: sum > 999 ? sum.unit() : sum + "b", unit: true }',
    {
        view: 'block',
        className: 'metric-stat',
        content: 'text-numeric:`${min != max ? min + "…" : ""}${max.bytes()} × ${count}`'
    }
];
const metricCells = metrics.map(({ key, header }) => ({
    header,
    className: 'metric-cell lifespan-' + key,
    sorting: `$["${key}"].sum desc`,
    data: `$["${key}"]`,
    content: metricView
}));

discovery.view.define('allocation-samples-matrix', {
    view: 'table',
    data: 'sort(type.order() asc)',
    cols: [
        {
            header: 'Type',
            sorting: 'type.order() asc',
            content: 'labeled-value{ text: type, color: type.color() }'
        },
        ...metricCells
    ],
    postRender(el, config, data, context) {
        if (data?.length < 2) {
            return;
        }

        const rowEl = createElement('tr', 'view-table-row');

        el.append(createElement('tbody', 'footer', [
            // createElement('tr', 'view-table-row', [createElement('td', { colSpan: 100 })]),
            rowEl
        ]));

        rowEl.append(
            createElement('td', 'view-table-cell', 'All types'),
            ...metrics.map(({ key }) => {
                const cellEl = createElement('td', 'view-table-cell metric-cell lifespan-' + key);
                const acc = data.reduce(
                    (acc, { [key]: col }) => col
                        ? {
                            sum: acc.sum + col.sum,
                            count: acc.count + col.count,
                            min: Math.min(acc.min, col.min),
                            max: Math.max(acc.max, col.max)
                        }
                        : acc,
                    { sum: 0, count: 0, min: Infinity, max: 0 }
                );

                if (acc.sum) {
                    discovery.view.render(cellEl, metricView, acc, context);
                }

                return cellEl;
            })
        );
    }
});
