discovery.page.define('module', {
    view: 'context',
    data: 'modules[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Module" }',
                'badge{ className: "category-badge", text: category.name, href: category.marker().href, color: category.name.color() }',
                'package-badge'
            ],
            content: 'h1:packageRelPath or name or path'
        },

        {
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.modulesTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.modulesTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.modulesTimings.entries[=>entry = @],
                    filtered: #.data.modulesTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Nested timings"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.modulesTree, timings: #.data.modulesTimingsFiltered }'
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: [
                'text:"Functions "',
                { view: 'pill-badge', content: {
                    view: 'update-on-timings-change',
                    timings: '=#.data.functionsTimingsFiltered',
                    content: 'text-numeric:#.data.functionsTimingsFiltered.entries.[totalTime and entry.module = @].size()'
                } }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                content: {
                    view: 'update-on-timings-change',
                    timings: '=#.data.functionsTimingsFiltered',
                    content: {
                        view: 'table',
                        data: '#.data.functionsTimingsFiltered.entries.[totalTime and entry.module = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Function', sorting: 'entry.name ascN', content: 'auto-link{ data: entry, content: "text-match:{ ..., match: #.filter }" }' },
                            { header: 'Loc', data: 'entry', sorting: 'entry.loc ascN', content: ['module-badge', 'loc-badge'] }
                        ]
                    }
                }
            }
        },

        {
            view: 'flamechart-expand',
            tree: '=#.data.modulesTree',
            timings: '=#.data.modulesTreeTimingsFiltered',
            value: '='
        }
    ]
});
