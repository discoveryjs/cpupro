import { createElement } from '@discoveryjs/discovery/utils';

const metrics = [
    { key: 'total', header: 'All lifespans' },
    { key: 'alive', header: 'Alive' },
    { key: 'long-lived', header: 'Long lived' },
    { key: 'short-lived', header: 'Short lived' }
];
const metricCells = metrics.map(({ key, header }) => ({
    header,
    className: 'metric-cell lifespan-' + key,
    sorting: `$["${key}"].sum desc`,
    data: `$["${key}"]`,
    content: {
        view: 'block',
        when: 'sum',
        content: [
            'text-with-unit{ value: sum > 999 ? sum.unit() : sum + "b", unit: true }',
            {
                view: 'block',
                className: 'metric-stat',
                content: 'text-numeric:`${min != max ? min + "…" : ""}${max.bytes()} × ${count}`'
            }
        ]
    }
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
                const sum = data.reduce((sum, entry) => sum + (entry[key]?.sum ?? 0), 0);
                const cellEl = createElement('td', 'view-table-cell metric-cell lifespan-' + key);

                if (sum) {
                    discovery.view.render(
                        cellEl,
                        'text-with-unit{ value: sum > 999 ? sum.unit() : sum + "b", unit: true }',
                        { sum },
                        context
                    );
                }

                return cellEl;
            })
        );
    }
});
