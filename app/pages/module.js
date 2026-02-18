import { primaryLineSwitcher, sessionExpandState, timingCols } from './common.js';

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Module" }',
            'badge{ className: "category-badge", text: category.name, href: category.marker().href, color: category.name.color() }',
            'package-badge',
            primaryLineSwitcher
        ],
        content: 'h1:packageRelPath or name or path'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.scopeProfile.modulesTree }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeLine().dict.modules.filtered',
        content: `page-indicator-metrics:scopeLine().dict.modules | {
            full: all.entries[=>entry = @],
            filtered: filtered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        className: 'trigger-outside script-source',
        context: '{ ...#, currentScript: script }',
        ...sessionExpandState('module-source', false),
        header: [
            'text:"Source"',
            { view: 'block', className: 'text-divider' },
            { view: 'switch', content: [
                { when: 'script.hasSource()', content: 'html:`<span style="color: #888">${script.source.size().bytes(true)}</html>`' },
                { content: 'html:`<span style="color: #888">(unavailable)</span>`' }
            ] }
        ],
        content: 'script-source:script'
    },

    {
        view: 'expand',
        ...sessionExpandState('module-nested-time-distribution', false),
        className: 'trigger-outside',
        header: [
            'text:`${"nestedValue".metricName()} distribution`',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().dict.modules.filtered',
                content: 'duration:scopeLine().dict.modules.filtered.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeLine() | {
            subject: @,
            tree: tree.modules.filtered.tree,
            metrics: dict.modules.filtered
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('module-call-frames', true),
        className: 'trigger-outside',
        header: [
            'text:"Call frames "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeLine().dict.callFrames.filtered.entries.[entry.module = @]',
                metrics: '=scopeLine().dict.callFrames.filtered',
                content: 'sampled-count-total{ count(=> totalValue?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            data: `
                scopeLine() | dict.callFrames.filtered.entries
                    .[entry.module = @]
                    .zip(=> entry, profile.codesByCallFrame, => callFrame)
                    .({
                        $entry: left.entry;

                        ...,
                        $entry,
                        name: $entry.name,
                        moduleName: $entry.module.name,
                        loc: $entry.loc
                    })
            `,
            content: {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().dict.callFrames.filtered',
                content: {
                    view: 'table',
                    data: `
                        .[name ~= #.filter]
                        .({
                            ...,
                            selfValue: left.selfValue,
                            nestedValue: left.nestedValue,
                            totalValue: left.totalValue
                        })
                        .sort(selfValue desc, totalValue desc, loc ascN)
                    `,
                    cols: [
                        ...timingCols,
                        {
                            header: '',
                            colWhen: '$[=>right]',
                            sorting: 'right.hotness | $ = "hot" ? 3 : $ = "warm" ? 2 : $ = "cold" ? 1 : 0 desc',
                            data: 'right',
                            contentWhen: 'hotness = "hot" or hotness = "warm"',
                            content: 'code-hotness-icon:topTier'
                        },
                        { header: 'Kind',
                            content: 'call-frame-kind-badge:left.entry.kind'
                        },
                        { header: 'Call frame',
                            className: 'subject-name',
                            sorting: 'name ascN',
                            content: {
                                view: 'badge',
                                data: 'entry.marker() | { text: title, href, match: #.filter }',
                                content: 'text-match'
                            }
                        },
                        { header: 'Loc',
                            sorting: 'loc ascN',
                            data: 'entry',
                            content: ['module-badge', 'call-frame-loc-badge']
                        }
                    ]
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        ...sessionExpandState('module-flame-graphs', true),
        tree: '=#.scopeProfile.modulesTree',
        value: '='
    }
];

discovery.page.define('module', {
    view: 'switch',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    data: '#.scopeProfile.modules[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No module with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
