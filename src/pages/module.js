discovery.page.define('module', {
    view: 'context',
    data: 'modules[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Module" }',
                'package-badge'
            ],
            content: 'h1:packageRelPath or name or path'
        },

        'text:"Self time: " + selfTime.ms()',
        'html:"<br>"',
        'text:"Total time: " + totalTime.ms()',

        'timeline-segments: $m:$; (calls + calls..children).[module=$m].segments',

        'h2:"Function calls"',
        {
            view: 'table',
            data: 'functions.sort(selfTime desc, totalTime desc)',
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Function', content: 'auto-link' },
                { header: 'Loc', content: 'text:loc or ""' }
            ]
        }
    ]
});
