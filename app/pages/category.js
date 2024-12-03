import { timingCols } from './common.js';

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
        content: `page-indicator-timings:{
            full: #.currentProfile.categoriesTimings.entries[=>entry = @],
            filtered: #.currentProfile.categoriesTimingsFiltered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        expanded: false,
        className: 'trigger-outside',
        header: [
            'text:"Nested time distribution"',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.categoriesTimingsFiltered',
                content: 'duration:#.currentProfile.categoriesTimingsFiltered.entries[=>entry=@].nestedTime'
            }
        ],
        content: `nested-timings-tree:{
            subject: @,
            tree: #.currentProfile.categoriesTree,
            timings: #.currentProfile.callFramesTimingsFiltered
        }`
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
                    data: '#.currentProfile.packagesTimingsFiltered.entries.[entry.category = @]',
                    timings: '=#.currentProfile.packagesTimingsFiltered',
                    content: 'sampled-count-total{ count(=> totalTime?), total: size() }'
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                data: `
                    #.currentProfile.callFramesTimingsFiltered.entries
                        .[entry.category = @]
                        .group(=> entry.module)
                        .zip(=> key, #.currentProfile.modulesTimingsFiltered.entries, => entry)
                        .({ module: right, callFrames: left.value })
                        .group(=> module.entry.package)
                        .zip(=> key, #.currentProfile.packagesTimingsFiltered.entries, => entry)
                        .({ package: right, modules: left.value })
                `,
                content: {
                    view: 'update-on-timings-change',
                    data: '.[package.entry.name ~= #.filter]',
                    timings: '=#.currentProfile.packagesTimingsFiltered',
                    content: {
                        view: 'table',
                        data: `.({
                                ...,
                                name: package.entry.name,
                                selfTime: package.selfTime,
                                totalTime: package.totalTime,
                                nestedTime: package.nestedTime
                            })
                            .sort(selfTime desc, totalTime desc)
                        `,
                        cols: [
                            ...timingCols,
                            { header: 'Package', sorting: 'name asc', content: 'package-badge:package.entry' },
                            {
                                header: 'Modules',
                                className: 'number',
                                data: 'modules.module',
                                content: 'sampled-count-total{ hideZeroCount: true, count(=> totalTime?), total: size() }',
                                details: 'struct{ expanded: 1 }'
                            },
                            {
                                header: 'Call frames',
                                className: 'number',
                                data: 'modules.callFrames',
                                content: 'sampled-count-total{ hideZeroCount: true, count(=> totalTime?), total: size() }',
                                details: 'struct{ expanded: 1 }'
                            }
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
                data: '#.currentProfile.modulesTimingsFiltered.entries.[entry.category = @]',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: 'sampled-count-total{ count(=> totalTime?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            data: `
                #.currentProfile.callFramesTimingsFiltered.entries
                    .[entry.category = @]
                    .group(=> entry.module)
                    .zip(=> key, #.currentProfile.modulesTimingsFiltered.entries, => entry)
                    .({ module: right, name: right.entry.name, callFrames: left.value })
            `,
            content: {
                view: 'update-on-timings-change',
                data: '.[name ~= #.filter]',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: {
                    view: 'table',
                    data: `
                        .({
                            ...,
                            selfTime: module.selfTime,
                            totalTime: module.totalTime,
                            nestedTime: module.nestedTime
                        })
                        .sort(selfTime desc, totalTime desc)
                    `,
                    cols: [
                        ...timingCols,
                        { header: 'Module', sorting: 'name ascN',content: 'module-badge:module.entry' },
                        {
                            header: 'Call frames',
                            className: 'number',
                            data: 'callFrames',
                            content: 'sampled-count-total{ hideZeroCount: true, count(=> totalTime?), total: size() }',
                            details: 'struct{ expanded: 1 }'
                        }
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
