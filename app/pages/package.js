import { callFramesCol, sessionExpandState, timingCols } from './common.js';

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
        data: '{ subject: @, tree: scopeTree().packages.all.nodes }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeTree().packages.filtered.dict',
        content: `page-indicator-metrics:scopeTree().packages | {
            full: all.dict.entries[=>entry = @],
            filtered: filtered.dict.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('package-nested-time-distribution', true),
        className: 'trigger-outside',
        header: [
            'text:`${"nestedValue".metricName()} distribution`',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeTree().packages.filtered.dict',
                content: 'metric:scopeTree().packages.filtered.dict.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeTree() | {
            subject: @,
            tree: packages.tree,
            metrics: packages.filtered.dict
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('package-modules', true),
        className: 'trigger-outside',
        header: [
            'text:"Modules "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeTree().modules.filtered.dict.entries.[entry.package = @]',
                metrics: '=scopeTree().modules.filtered.dict',
                content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            data: `
                scopeTree() | callFrames.filtered.dict.entries
                    .[entry.package = @]
                    .group(=> entry.module)
                    .zip(=> key, modules.all.dict.entries, => entry)
                    .({ module: right, name: right.entry | packageRelPath or name, callFrames: left.value })
            `,
            className: 'table-content-filter',
            content: {
                view: 'update-on-line-metrics-changes',
                data: '.[name ~= #.filter]',
                metrics: '=scopeTree().modules.filtered.dict',
                content: {
                    view: 'table',
                    data: `
                        .({
                            ...,
                            selfValue: module.selfValue,
                            nestedValue: module.nestedValue,
                            totalValue: module.totalValue
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
                        callFramesCol('callFrames.sort(selfValue desc, totalValue desc, entry.name ascN)')
                        // { header: 'Histogram', content: {
                        //     view: 'sample-histogram',
                        //     bins: '=#.data.modulesTree.binCalls(entry, 100)',
                        //     max: '=#.data.totalValue / 100',
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
        ...sessionExpandState('package-flame-graphs', true),
        tree: '=scopeTree().packages.tree',
        value: '='
    }
];

discovery.page.define('package', {
    view: 'switch',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    data: '#.scopeProfile.packages[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No package with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
