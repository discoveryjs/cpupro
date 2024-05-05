const pageContent = {
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Category" }'
            ],
            content: 'h1:name'
        },

        {
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.categoriesTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.categoriesTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.categoriesTimings.entries[=>entry = @],
                    filtered: #.data.categoriesTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            expanded: false,
            className: 'trigger-outside',
            header: 'text:"Nested time distribution"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.categoriesTree, timings: #.data.functionsTimingsFiltered }'
        },

        {
            view: 'context',
            when: 'name in ["script", "chrome-extension"]',
            content: {
                view: 'expand',
                expanded: true,
                className: 'trigger-outside',
                header: [
                    'text:"Packages "',
                    {
                        view: 'update-on-timings-change',
                        timings: '=#.data.packagesTimingsFiltered',
                        content: { view: 'pill-badge', content: 'text-numeric:#.data.packagesTimingsFiltered.entries.[totalTime and entry.category = @].size()' }
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
                            data: '#.data.packagesTimingsFiltered.entries.[totalTime and entry.category = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
                    content: { view: 'pill-badge', content: 'text-numeric:#.data.modulesTimingsFiltered.entries.[totalTime and entry.category = @].size()' }
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
                        data: '#.data.modulesTimingsFiltered.entries.[totalTime and entry.category = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
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
        },

        {
            view: 'flamechart-expand',
            tree: '=#.data.categoriesTree',
            timings: '=#.data.categoriesTreeTimingsFiltered',
            value: '='
        }
    ]
};

discovery.page.define('category', {
    view: 'switch',
    data: 'categories[=>name = #.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No category with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        pageContent
    ]
});
