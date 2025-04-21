import { callFramesCol, sessionExpandState, timingCols } from './common.js';

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
        ...sessionExpandState('category-nested-time-distribution', false),
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
            ...sessionExpandState('category-packages', true),
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
                            {
                                header: 'Package',
                                className: 'subject-name',
                                sorting: 'name asc',
                                content: 'package-badge:package.entry'
                            },
                            {
                                header: 'Modules',
                                className: 'number sampled-numbers',
                                data: 'modules.sort(module.selfTime desc, module.totalTime desc)',
                                content: 'sampled-count-total{ hideZeroCount: true, count: module.count(=> totalTime?), total: size() }',
                                details: [
                                    {
                                        view: 'table',
                                        className: 'full-width-table',
                                        data: '.({ ..., selfTime: module.selfTime, nestedTime: module.nestedTime, totalTime: module.totalTime })',
                                        cols: [
                                            ...timingCols,
                                            {
                                                header: 'Module',
                                                className: 'subject-name',
                                                sorting: 'module.entry.name ascN',
                                                content: 'module-badge:module.entry'
                                            },
                                            callFramesCol('callFrames.sort(selfTime desc, totalTime desc)')
                                        ]
                                    }
                                ]
                            },
                            callFramesCol('modules.callFrames.sort(selfTime desc, totalTime desc)', true)
                        ]
                    }
                }
            }
        }
    },

    {
        view: 'expand',
        ...sessionExpandState('category-modules', true),
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
                    .sort(name ascN)
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
                        {
                            header: 'Module',
                            className: 'subject-name',
                            sorting: 'name ascN',
                            content: 'module-badge:module.entry'
                        },
                        callFramesCol('callFrames.sort(selfTime desc, totalTime desc)')
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        ...sessionExpandState('category-flame-graphs', true),
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
