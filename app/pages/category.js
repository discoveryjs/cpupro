const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Category" }'
        ],
        content: 'h1:name'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.currentProfile.categoriesTree }'
    },

    {
        view: 'update-on-timings-change',
        timings: '=#.currentProfile.categoriesTimingsFiltered',
        content: {
            view: 'page-indicator-timings',
            data: `{
                full: #.currentProfile.categoriesTimings.entries[=>entry = @],
                filtered: #.currentProfile.categoriesTimingsFiltered.entries[=>entry = @]
            }`
        }
    },

    {
        view: 'expand',
        expanded: false,
        className: 'trigger-outside',
        header: 'text:"Nested time distribution"',
        content: 'nested-timings-tree:{ subject: @, tree: #.currentProfile.categoriesTree, timings: #.currentProfile.functionsTimingsFiltered }'
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
                    timings: '=#.currentProfile.packagesTimingsFiltered',
                    content: { view: 'pill-badge', content: 'text-numeric:#.currentProfile.packagesTimingsFiltered.entries.[totalTime and entry.category = @].size()' }
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                content: {
                    view: 'update-on-timings-change',
                    timings: '=#.currentProfile.packagesTimingsFiltered',
                    content: {
                        view: 'table',
                        data: '#.currentProfile.packagesTimingsFiltered.entries.[totalTime and entry.category = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Package', sorting: 'entry.name asc', content: 'package-badge:entry' },
                            { header: 'Modules', data: 'entry.modules' },
                            { header: 'Call frames', data: 'entry.modules.functions' }
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
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: { view: 'pill-badge', content: 'text-numeric:#.currentProfile.modulesTimingsFiltered.entries.[totalTime and entry.category = @].size()' }
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            content: {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: {
                    view: 'table',
                    data: '#.currentProfile.modulesTimingsFiltered.entries.[totalTime and entry.category = @ and entry.name ~= #.filter].sort(selfTime desc, totalTime desc)',
                    cols: [
                        { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                        { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                        { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                        { header: 'Module', sorting: 'entry.name ascN',content: 'module-badge:entry' },
                        { header: 'Call frames', data: 'entry.functions' }
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        tree: '=#.currentProfile.categoriesTree',
        timings: '=#.currentProfile.categoriesTreeTimingsFiltered',
        value: '='
    }
];

discovery.page.define('category', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.categories[=>name = #.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No category with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
