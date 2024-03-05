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
                    bins: '=binCalls(#.data.packagesTree, $, 500)',
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

        {
            view: 'context',
            data: 'modules.sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Modules "', 'badge:size()'] },
                {
                    view: 'table',
                    cols: [
                        { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                        { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                        { header: 'Module', sorting: '(packageRelPath or name or path) asc', content: 'module-badge' },
                        { header: 'Histogram', content: {
                            view: 'timeline-segments-bin',
                            bins: '=binCalls(#.data.modulesTree, $, 100)',
                            max: '=#.data.totalTime / 100',
                            binsMax: true,
                            color: '=area.name.color()',
                            height: 22
                        } }
                    ]
                }
            ]
        }
    ]
});
