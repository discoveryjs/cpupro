discovery.page.define('package', {
    view: 'context',
    data: 'packages[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: 'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Package" }',
            content: 'h1:name'
        },

        {
            view: 'block',
            className: 'indicators',
            content: [
                {
                    view: 'page-indicator',
                    title: 'Self time',
                    value: '=selfTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Self time, %',
                    value: '=selfTime.totalPercent()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time',
                    value: '=totalTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time, %',
                    value: '=totalTime.totalPercent()',
                    unit: true
                }
            ]
        },

        'timeline-segments: modules.($m:$; (calls + calls..children).[module=$m].segments)',

        'h2:"Modules"',
        {
            view: 'table',
            data: 'modules.sort(selfTime desc, totalTime desc)',
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Module', sorting: '(packageRelPath or name or path) asc', content: 'module-badge' }
            ]
        },

        'flow'
    ]
});
