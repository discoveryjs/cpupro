discovery.page.define('area', {
    view: 'context',
    data: 'areas[=>name = #.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Area" }'
            ],
            content: 'h1:name'
        },

        {
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.areasTree }'
        },

        {
            view: 'draft-timings-related',
            source: '=#.data.areasTimings',
            content: {
                view: 'page-indicator-timings',
                data: '#.data.areasTimings.entries[=>entry = @]'
            }
        },

        {
            view: 'context',
            when: 'name = "script"',
            data: '#.data.packagesTimings.entries.[entry.area = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Packages "', 'pill-badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[entry.name ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Package', sorting: 'entry.name asc', content: 'package-badge:entry' },
                            { header: 'Modules', data: 'entry.modules' },
                            { header: 'Functions', data: 'entry.modules.functions' }
                        ]
                    }
                }
            ]
        },

        {
            view: 'h2',
            content: [
                'text:"Modules "',
                {
                    view: 'draft-timings-related',
                    source: '=#.data.modulesTimings',
                    content: { view: 'pill-badge', content: 'text-numeric:#.data.modulesTimings.entries.[totalTime and entry.area = @].size()' }
                }
            ]
        },
        {
            view: 'content-filter',
            content: {
                view: 'draft-timings-related',
                source: '=#.data.modulesTimings',
                content: {
                    view: 'table',
                    data: '#.data.modulesTimings.entries.[totalTime and entry.area = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
                    cols: [
                        { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                        { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                        { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                        { header: 'Module', sorting: 'entry.name ascN',content: 'module-badge:entry' },
                        { header: 'Functions', data: 'entry.functions' }
                    ]
                }
            }
        }
    ]
});
