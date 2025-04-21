const metrics = [
    { key: 'total', header: 'All lifespans' },
    { key: 'alive', header: 'Alive' },
    { key: 'long-lived', header: 'Long lived' },
    { key: 'short-lived', header: 'Short lived' }
];
const metricView = {
    view: 'context',
    when: 'sum',
    content: [
        'text-with-unit{ value: sum > 999 ? sum.unit() : sum + "b", unit: true }',
        {
            view: 'block',
            className: 'metric-stat',
            content: 'text-numeric:`${min != max ? min + "…" : ""}${max.bytes()} × ${count}`'
        }
    ]
};
const metricCells = metrics.map(({ key, header }) => ({
    header,
    className: 'metric-cell lifespan-' + key,
    sorting: `$["${key}"].sum desc`,
    data: `$["${key}"]`,
    content: metricView,
    footer: {
        className: 'metric-cell lifespan-' + key,
        data: `.($["${key}"]) | { count: sum(=>count), sum(=>sum), min.min(), max.max() }`,
        content: metricView
    }
}));

discovery.view.define('allocation-samples-matrix', {
    view: 'table',
    data: 'sort(type.order() asc)',
    cols: [
        {
            header: 'Type',
            sorting: 'type.order() asc',
            content: 'labeled-value{ text: type, color: type.color() }',
            footer: 'text:"All types"'
        },
        ...metricCells
    ],
    headerWhen: 'size() > 1',
    footerWhen: 'size() > 1'
});
