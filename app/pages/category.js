import { callFramesCol, primaryLineSwitcher, sessionExpandState, timingCols } from './common.js';

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Category" }',
            primaryLineSwitcher
        ],
        content: 'h1:name'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: scopeProfile().categoriesTree }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeLine().dict.categories.filtered',
        content: `page-indicator-metrics:scopeLine().dict.categories | {
            full: all.entries[=>entry = @],
            filtered: filtered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('category-nested-time-distribution', false),
        className: 'trigger-outside',
        header: [
            'text:`${"nestedValue".metricName()} distribution`',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().dict.categories.filtered',
                content: 'metric:scopeLine().dict.categories.filtered.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeLine() | {
            subject: @,
            tree: profile.categoriesTree,
            metrics: dict.callFrames.filtered
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
                    view: 'update-on-line-metrics-changes',
                    data: 'scopeLine().dict.packages.filtered.entries.[entry.category = @]',
                    metrics: '=scopeLine().dict.packages.filtered',
                    content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                data: `
                    scopeLine() | dict.callFrames.filtered.entries
                        .[entry.category = @]
                        .group(=> entry.module)
                        .zip(=> key, dict.modules.filtered.entries, => entry)
                        .({ module: right, callFrames: left.value })
                        .group(=> module.entry.package)
                        .zip(=> key, dict.packages.filtered.entries, => entry)
                        .({ package: right, modules: left.value })
                `,
                content: {
                    view: 'update-on-line-metrics-changes',
                    data: '.[package.entry.name ~= #.filter]',
                    metrics: '=scopeLine().dict.packages.filtered',
                    content: {
                        view: 'table',
                        data: `.({
                                ...,
                                name: package.entry.name,
                                selfValue: package.selfValue,
                                totalValue: package.totalValue,
                                nestedValue: package.nestedValue
                            })
                            .sort(selfValue desc, totalValue desc)
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
                                data: 'modules.sort(module.selfValue desc, module.totalValue desc)',
                                content: 'sampled-count-total{ hideZeroCount: true, count: module.count(=> totalValue?), total: size() }',
                                details: [
                                    {
                                        view: 'table',
                                        className: 'full-width-table',
                                        data: '.({ ..., selfValue: module.selfValue, nestedValue: module.nestedValue, totalValue: module.totalValue })',
                                        cols: [
                                            ...timingCols,
                                            {
                                                header: 'Module',
                                                className: 'subject-name',
                                                sorting: 'module.entry.name ascN',
                                                content: 'module-badge:module.entry'
                                            },
                                            callFramesCol('callFrames.sort(selfValue desc, totalValue desc)')
                                        ]
                                    }
                                ]
                            },
                            callFramesCol('modules.callFrames.sort(selfValue desc, totalValue desc)', true)
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
                view: 'update-on-line-metrics-changes',
                data: 'scopeLine().dict.modules.filtered.entries.[entry.category = @]',
                metrics: '=scopeLine().dict.modules.filtered',
                content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            data: `
                scopeLine() | dict.callFrames.filtered.entries
                    .[entry.category = @]
                    .group(=> entry.module)
                    .zip(=> key, dict.modules.filtered.entries, => entry)
                    .({ module: right, name: right.entry.name, callFrames: left.value })
                    .sort(name ascN)
            `,
            content: {
                view: 'update-on-line-metrics-changes',
                data: '.[name ~= #.filter]',
                metrics: '=scopeLine().dict.modules.filtered',
                content: {
                    view: 'table',
                    data: `
                        .({
                            ...,
                            selfValue: module.selfValue,
                            totalValue: module.totalValue,
                            nestedValue: module.nestedValue
                        })
                        .sort(selfValue desc, totalValue desc)
                    `,
                    cols: [
                        ...timingCols,
                        {
                            header: 'Module',
                            className: 'subject-name',
                            sorting: 'name ascN',
                            content: 'module-badge:module.entry'
                        },
                        callFramesCol('callFrames.sort(selfValue desc, totalValue desc)')
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        ...sessionExpandState('category-flame-graphs', true),
        tree: '=scopeProfile().categoriesTree',
        value: '='
    }
];

discovery.page.define('category', {
    view: 'switch',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    data: '#.scopeProfile.categories[=>name = #.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No category with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
