discovery.page.define('module', {
    view: 'context',
    data: 'modules[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Module" }',
                'badge{ className: "area-badge", text: area.name, href: area.marker().href, color: area.name.color() }',
                'package-badge'
            ],
            content: 'h1:packageRelPath or name or path'
        },

        {
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.modulesTree }'
        },

        {
            view: 'draft-timings-related',
            source: '=#.data.modulesTimings',
            content: {
                view: 'page-indicator-timings',
                data: '#.data.modulesTimings.entries[=>entry = @]'
            }
        },

        'nested-timings-tree:{ subject: @, tree: #.data.modulesTree, timings: #.data.modulesTimings }',

        {
            view: 'h2',
            content: [
                'text:"Functions "',
                { view: 'pill-badge', content: {
                    view: 'draft-timings-related',
                    source: '=#.data.functionsTimings',
                    content: 'text-numeric:#.data.functionsTimings.entries.[totalTime and entry.module = @].size()'
                } }
            ]
        },
        {
            view: 'content-filter',
            content: {
                view: 'draft-timings-related',
                source: '=#.data.functionsTimings',
                content: {
                    view: 'table',
                    data: '#.data.functionsTimings.entries.[totalTime and entry.module = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
    ]
});
