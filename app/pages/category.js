import { callFramesCol, sessionExpandState, valueCols } from './common.js';

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
        data: '{ subject: @, tree: scopeBreakdown().categories.all.nodes }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeBreakdown().categories.filtered.dict',
        content: `page-indicator-metrics:scopeBreakdown().categories | {
            full: all.dict.entries[=>entry = @],
            filtered: filtered.dict.entries[=>entry = @]
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
                metrics: '=scopeBreakdown().categories.filtered.dict',
                content: 'metric:scopeBreakdown().categories.filtered.dict.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeBreakdown() | {
            subject: @,
            tree: categories.tree,
            metrics: callFrames.filtered.dict
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
                    data: 'scopeBreakdown().packages.filtered.dict.entries.[entry.category = @]',
                    metrics: '=scopeBreakdown().packages.filtered.dict',
                    content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                data: `
                    scopeBreakdown() | callFrames.filtered.dict.entries
                        .[entry.category = @]
                        .group(=> entry.module)
                        .zip(=> key, modules.filtered.dict.entries, => entry)
                        .({ module: right, callFrames: left.value })
                        .group(=> module.entry.package)
                        .zip(=> key, packages.filtered.dict.entries, => entry)
                        .({ package: right, modules: left.value })
                `,
                content: {
                    view: 'update-on-line-metrics-changes',
                    data: '.[package.entry.name ~= #.filter]',
                    metrics: '=scopeBreakdown().packages.filtered.dict',
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
                            ...valueCols,
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
                                            ...valueCols,
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
                data: 'scopeBreakdown().modules.filtered.dict.entries.[entry.category = @]',
                metrics: '=scopeBreakdown().modules.filtered.dict',
                content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            data: `
                scopeBreakdown() | callFrames.filtered.dict.entries
                    .[entry.category = @]
                    .group(=> entry.module)
                    .zip(=> key, modules.filtered.dict.entries, => entry)
                    .({ module: right, name: right.entry.name, callFrames: left.value })
                    .sort(name ascN)
            `,
            content: {
                view: 'update-on-line-metrics-changes',
                data: '.[name ~= #.filter]',
                metrics: '=scopeBreakdown().modules.filtered.dict',
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
                        ...valueCols,
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
        tree: '=scopeBreakdown().categories.tree',
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
