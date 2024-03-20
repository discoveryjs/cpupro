discovery.view.define('page-indicator-timings', {
    view: 'page-indicator-group',
    content: [
        {
            title: 'Self time',
            value: '=selfTime | ? ms() : "—"',
            unit: true
        },
        {
            title: 'Self time, %',
            value: '=selfTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Nested time',
            value: '=nestedTime | ? ms() : "—"',
            unit: true
        },
        {
            title: 'Nested time, %',
            value: '=nestedTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Total time',
            value: '=totalTime | ? ms() : "—"',
            unit: true
        },
        {
            title: 'Total time, %',
            value: '=totalTime | ? totalPercent() : "—"',
            unit: true
        }
    ]
}, { tag: false });
