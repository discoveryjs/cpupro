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
            view: 'update-on-timings-change',
            timings: '=#.data.areasTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.areasTimings.entries[=>entry = @],
                    filtered: #.data.areasTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'context',
            when: 'name = "script"',
            content: {
                view: 'expand',
                expanded: true,
                className: 'trigger-outside',
                header: [
                    'text:"Packages "',
                    {
                        view: 'update-on-timings-change',
                        timings: '=#.data.packagesTimingsFiltered',
                        content: { view: 'pill-badge', content: 'text-numeric:#.data.packagesTimingsFiltered.entries.[totalTime and entry.area = @].size()' }
                    }
                ],
                content: {
                    view: 'content-filter',
                    className: 'table-content-filter',
                    content: {
                        view: 'update-on-timings-change',
                        timings: '=#.data.packagesTimingsFiltered',
                        content: {
                            view: 'table',
                            data: '#.data.packagesTimingsFiltered.entries.[totalTime and entry.area = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
                }
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: [
                'text:"Modules "',
                {
                    view: 'update-on-timings-change',
                    timings: '=#.data.modulesTimingsFiltered',
                    content: { view: 'pill-badge', content: 'text-numeric:#.data.modulesTimingsFiltered.entries.[totalTime and entry.area = @].size()' }
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                content: {
                    view: 'update-on-timings-change',
                    timings: '=#.data.modulesTimingsFiltered',
                    content: {
                        view: 'table',
                        data: '#.data.modulesTimingsFiltered.entries.[totalTime and entry.area = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
        }
    ]
});
