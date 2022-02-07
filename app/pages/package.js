discovery.page.define('package', {
    view: 'context',
    data: 'packages[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: 'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Package" }',
            content: 'h1:name'
        },

        'text:"Self time: " + selfTime.ms()',
        'html:"<br>"',
        'text:"Total time: " + totalTime.ms()',

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
