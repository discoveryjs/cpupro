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
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.packagesTree }'
        },

        {
            view: 'draft-timings-related',
            source: '=#.data.packagesTimings',
            content: {
                view: 'page-indicator-timings',
                data: '#.data.packagesTimings.entries[=>entry = @]'
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Nested timings"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.packagesTree, timings: #.data.packagesTimings }'
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: [
                'text:"Modules "',
                { view: 'pill-badge', content: {
                    view: 'draft-timings-related',
                    source: '=#.data.modulesTimings',
                    content: 'text-numeric:#.data.modulesTimings.entries.[totalTime and entry.package = @].size()'
                } }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                content: {
                    view: 'draft-timings-related',
                    source: '=#.data.packagesTimings',
                    content: {
                        view: 'table',
                        data: '#.data.modulesTimings.entries.[totalTime and entry.package = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Module', sorting: 'entry.name ascN', content: 'module-badge:entry' },
                            { header: 'Functions', data: 'entry.functions' }
                            // { header: 'Histogram', content: {
                            //     view: 'timeline-segments-bin',
                            //     bins: '=#.data.modulesTree.binCalls(entry, 100)',
                            //     max: '=#.data.totalTime / 100',
                            //     binsMax: true,
                            //     color: '=entry.area.name.color()',
                            //     height: 22
                            // } }
                        ]
                    }
                }
            }
        }
    ]
});
