const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Package" }',
            'badge{ className: "category-badge", text: category.name, href: category.marker().href, color: category.name.color() }'
        ],
        content: 'h1:name'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.currentProfile.packagesTree }'
    },

    {
        view: 'update-on-timings-change',
        timings: '=#.currentProfile.packagesTimingsFiltered',
        content: {
            view: 'page-indicator-timings',
            data: `{
                full: #.currentProfile.packagesTimings.entries[=>entry = @],
                filtered: #.currentProfile.packagesTimingsFiltered.entries[=>entry = @]
            }`
        }
    },

    {
        view: 'expand',
        expanded: true,
        className: 'trigger-outside',
        header: 'text:"Nested time distribution"',
        content: 'nested-timings-tree:{ subject: @, tree: #.currentProfile.packagesTree, timings: #.currentProfile.packagesTimingsFiltered }'
    },

    {
        view: 'expand',
        expanded: true,
        className: 'trigger-outside',
        header: [
            'text:"Modules "',
            {
                view: 'pill-badge',
                data: '#.currentProfile.modulesTimingsFiltered.entries.[entry.package = @]',
                content: [
                    {
                        view: 'update-on-timings-change',
                        timings: '=#.currentProfile.modulesTimingsFiltered',
                        content: 'text-numeric:count(=> totalTime?)'
                    },
                    {
                        view: 'text-numeric',
                        className: 'total-number',
                        data: '` ⁄ ${size()}`'
                    }
                ]
            }
        ],
        content: {
            view: 'content-filter',
            data: `
                #.currentProfile.modulesTimingsFiltered.entries.[entry.package = @]
                    .zip(=> entry, #.currentProfile.functionsTimingsFiltered.entries.group(=> entry.module), => key)
                    .({ timings: left, functions: right.value })
                    .zip(=> timings.entry, #.currentProfile.scripts, => module)
                    .({
                        $timings: left.timings;
                        $entry: $timings.entry;

                        ...,
                        left: $timings,
                        functions: left.functions,
                        $entry,
                        name: $entry | packageRelPath or name,
                        packageName: $entry.package.name,
                        categoryName: $entry.category.name
                    })
            `,
            className: 'table-content-filter',
            content: {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: {
                    view: 'table',
                    data: `
                        .[name ~= #.filter]
                        .({
                            ...,
                            selfTime: left.selfTime,
                            nestedTime: left.nestedTime,
                            totalTime: left.totalTime
                        })
                        .sort(selfTime desc, totalTime desc)
                    `,
                    cols: [
                        { header: 'Self time',
                            sorting: 'selfTime desc, totalTime desc',
                            colSpan: '=totalTime ? 1 : 3',
                            content: {
                                view: 'switch',
                                content: [
                                    { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                    { content: 'no-samples' }
                                ]
                            }
                        },
                        { header: 'Nested time',
                            sorting: 'nestedTime desc, totalTime desc',
                            when: 'totalTime',
                            content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                        },
                        { header: 'Total time',
                            sorting: 'totalTime desc, selfTime desc',
                            when: 'totalTime',
                            content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                        },
                        { header: 'Module',
                            sorting: 'name ascN',
                            content: 'module-badge:entry'
                        },
                        { header: 'Call frames',
                            className: 'number',
                            data: 'functions',
                            content: [
                                { view: 'text-numeric', className: 'sampled-count', data: 'count(=> totalTime?)' },
                                'text-numeric:` ⁄ ${size()}`'
                            ],
                            details: 'struct'
                        }
                        // { header: 'Histogram', content: {
                        //     view: 'timeline-segments-bin',
                        //     bins: '=#.data.modulesTree.binCalls(entry, 100)',
                        //     max: '=#.data.totalTime / 100',
                        //     binsMax: true,
                        //     color: '=entry.category.name.color()',
                        //     height: 22
                        // } }
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        tree: '=#.currentProfile.packagesTree',
        timings: '=#.currentProfile.packagesTreeTimingsFiltered',
        value: '='
    }
];

discovery.page.define('package', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.packages[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No package with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
