import { callFramesCol, sessionExpandState, timingCols } from './common.js';

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Owner" }'
        ],
        content: 'h1:name'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: scopeTree().owners.all.nodes }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeTree().owners.filtered.dict',
        content: `page-indicator-metrics:scopeTree().owners | {
            full: all.dict.entries[=>entry = @],
            filtered: filtered.dict.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('owner-nested-time-distribution', true),
        className: 'trigger-outside',
        header: [
            'text:`${"nestedValue".metricName()} distribution`',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeTree().owners.filtered.dict',
                content: 'metric:scopeTree().owners.filtered.dict.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeTree() | {
            subject: @,
            tree: owners.tree,
            metrics: owners.filtered.dict
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('owner-modules', true),
        className: 'trigger-outside',
        header: [
            'text:"Modules "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeTree().modules.filtered.dict.entries.[entry.owner = @]',
                metrics: '=scopeTree().modules.filtered.dict',
                content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            data: `
                scopeTree() | callFrames.filtered.dict.entries
                    .[entry.module.owner = @]
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
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        ...sessionExpandState('owner-flame-graphs', true),
        tree: '=scopeTree().owners.tree',
        value: '='
    }
];

discovery.page.define('owner', {
    view: 'switch',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    data: '#.scopeProfile.owners[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No owner with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
