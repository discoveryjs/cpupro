discovery.view.define('page-indicator-timings', {
    view: 'page-indicator-group',
    content: [
        {
            title: 'Self time',
            value: '=selfTime | ? ms() : "—"',
            unit: '=selfTime > 0'
        },
        {
            title: 'Self time, %',
            value: '=selfTime | ? totalPercent() : "—"',
            unit: '=selfTime > 0'
        },
        {
            title: 'Nested time',
            value: '=nestedTime | ? ms() : "—"',
            unit: '=nestedTime > 0'
        },
        {
            title: 'Nested time, %',
            value: '=nestedTime | ? totalPercent() : "—"',
            unit: '=nestedTime > 0'
        },
        {
            title: 'Total time',
            value: '=totalTime | ? ms() : "—"',
            unit: '=totalTime > 0'
        },
        {
            title: 'Total time, %',
            value: '=totalTime | ? totalPercent() : "—"',
            unit: '=totalTime > 0'
        }
    ]
}, { tag: false });
