discovery.page.define('area', {
    view: 'context',
    data: 'areas[=>name = #.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Area" }'
            ],
            content: 'h1:name'
        },

        'h2:"Modules"',
        {
            view: 'table',
            data: 'calls.module.sort(selfTime desc, totalTime desc)',
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Module', content: 'module-badge' }
            ]
        },

        'h2:"Areas calls"',
        {
            view: 'table',
            data: 'children.sort(selfTime desc, totalTime desc)',
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Area', content: 'auto-link:to' }
            ]
        },

        'flow'
    ]
});
