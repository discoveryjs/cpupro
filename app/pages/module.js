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
            view: 'page-indicator-timings',
            data: '#.data.modulesTimings.entries[=>entry = @]'
        },

        {
            view: 'tree',
            data: `
                $functions: #.data.modulesTree.nestedTimings($, #.data.functionsTree);
                $totalTime: $functions.sum(=>selfTime);

                $functions
                    .({ function: entry, time: selfTime, total: $totalTime })
                    .sort(time desc)
                    .group(=>function.module)
                        .({ module: key, time: value.sum(=>time), total: $totalTime, functions: value })
                        .sort(time desc)
                    .group(=>module.package)
                        .({ package: key, time: value.sum(=>time), total: $totalTime, modules: value })
                        .sort(time desc)
            `,
            expanded: false,
            itemConfig: {
                content: ['package-badge:package', 'duration'],
                children: 'modules',
                itemConfig: {
                    content: ['module-badge:module', 'duration'],
                    children: 'functions',
                    itemConfig: {
                        content: ['function-badge:function', 'duration']
                    }
                }
            }
        },

        {
            view: 'context',
            data: '#.data.functionsTimings.entries.[entry.module = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Functions "', 'pill-badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[entry.name ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Function', sorting: 'entry.name ascN', content: 'auto-link{ data: entry, content: "text-match:{ ..., match: #.filter }" }' },
                            { header: 'Loc', data: 'entry', sorting: 'entry.loc ascN', content: ['module-badge', 'loc-badge'] }
                        ]
                    }
                }
            ]
        }
    ]
});
