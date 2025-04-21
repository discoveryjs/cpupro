// import { createElement } from '@discoveryjs/discovery/utils';

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
        'text:sum > 999 ? sum.unit() : sum + "b"',
        'text:` (${min != max ? min + "…" : ""}${max.bytes()} × ${count})`'
    ]
};
const metricCells = metrics.map(({ key, header }) => ({
    header,
    data: `$["${key}"]`,
    content: metricView,
    footer: {
        data: `.($["${key}"]) | { count: sum(=>count), sum(=>sum), min.min(), max.max() }`,
        content: metricView
    }
}));

export default function(host) {
    host.textView.define('allocation-samples-matrix', {
        view: 'table',
        data: 'sort(type.order() asc)',
        cols: [
            {
                header: 'Type',
                content: 'text:type',
                footer: 'text:"All types"'
            },
            ...metricCells
        ]
    });
}
