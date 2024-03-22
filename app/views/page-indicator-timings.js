discovery.view.define('page-indicator-timings', {
    view: 'page-indicator-group',
    className: 'view-page-indicator-timings',
    content: [
        {
            title: 'Self time',
            content: [
                { view: 'text-with-unit', value: '=filtered.selfTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.selfTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.selfTime != full.selfTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Self time, %',
            value: '=filtered.selfTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Nested time',
            content: [
                { view: 'text-with-unit', value: '=filtered.nestedTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.nestedTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.nestedTime != full.nestedTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Nested time, %',
            value: '=filtered.nestedTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Total time',
            content: [
                { view: 'text-with-unit', value: '=filtered.totalTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.totalTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.totalTime != full.totalTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Total time, %',
            value: '=filtered.totalTime | ? totalPercent() : "—"',
            unit: true
        }
    ]
}, { tag: false });
