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
            view: 'page-indicator-timings',
            data: '#.data.packagesTimings.entries[=>entry = @]'
        },

        {
            view: 'tree',
            data: `
                $functions: #.data.packagesTree.nestedTimings($, #.data.functionsTree);
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
            data: '#.data.modulesTimings.entries.[entry.package = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Modules "', 'badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[(entry | packageRelPath or name) ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Module', sorting: 'entry.name ascN', content: 'module-badge:entry' },
                            { header: 'Functions', data: 'entry.functions' },
                            { header: 'Histogram', content: {
                                view: 'timeline-segments-bin',
                                bins: '=#.data.modulesTree.binCalls(entry, 100)',
                                max: '=#.data.totalTime / 100',
                                binsMax: true,
                                color: '=entry.area.name.color()',
                                height: 22
                            } }
                        ]
                    }
                }
            ]
        }
    ]
});
