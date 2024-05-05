const pageContent = {
    content: [
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
            data: '{ subject: @, tree: #.data.packagesTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.packagesTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.packagesTimings.entries[=>entry = @],
                    filtered: #.data.packagesTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Nested time distribution"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.packagesTree, timings: #.data.packagesTimingsFiltered }'
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: [
                'text:"Modules "',
                { view: 'pill-badge', content: {
                    view: 'update-on-timings-change',
                    timings: '=#.data.modulesTimingsFiltered',
                    content: 'text-numeric:#.data.modulesTimingsFiltered.entries.[totalTime and entry.package = @].size()'
                } }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                content: {
                    view: 'update-on-timings-change',
                    timings: '=#.data.packagesTimingsFiltered',
                    content: {
                        view: 'table',
                        data: '#.data.modulesTimingsFiltered.entries.[totalTime and entry.package = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
            tree: '=#.data.packagesTree',
            timings: '=#.data.packagesTreeTimingsFiltered',
            value: '='
        }
    ]
};

discovery.page.define('package', {
    view: 'switch',
    data: 'packages[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No package with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        pageContent
    ]
});
