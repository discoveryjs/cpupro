discovery.page.define('package', {
    view: 'context',
    data: 'packages[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Package" }',
                'badge{ className: "area-badge", text: area.name, href: area.marker().href, color: area.name.color() }'
            ],
            content: 'h1:name'
        },

        {
            view: 'block',
            className: 'subject-timeline',
            content: [
                'time-ruler{ duration: #.data.totalTime, captions: "top" }',
                {
                    view: 'timeline-segments-bin',
                    bins: '=binCalls(=>module.package=@, 500)',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=area.name.color()',
                    height: 30
                }
            ]
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
