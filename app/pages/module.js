import { FEATURE_SOURCES } from '../prepare/const.js';
import { timingCols } from './common.js';

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Module" }',
            'badge{ className: "category-badge", text: category.name, href: category.marker().href, color: category.name.color() }',
            'package-badge'
        ],
        content: 'h1:packageRelPath or name or path'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.currentProfile.modulesTree }'
    },

    {
        view: 'update-on-timings-change',
        timings: '=#.currentProfile.modulesTimingsFiltered',
        content: `page-indicator-timings:{
            full: #.currentProfile.modulesTimings.entries[=>entry = @],
            filtered: #.currentProfile.modulesTimingsFiltered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        when: FEATURE_SOURCES,
        className: 'trigger-outside script-source',
        expanded: '=script.hasSource()',
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
        expanded: true,
        className: 'trigger-outside',
        header: [
            'text:"Nested time distribution"',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: 'duration:#.currentProfile.modulesTimingsFiltered.entries[=>entry=@].nestedTime'
            }
        ],
        content: `nested-timings-tree:{
            subject: @,
            tree: #.currentProfile.modulesTree,
            timings: #.currentProfile.modulesTimingsFiltered
        }`
    },

    {
        view: 'expand',
        expanded: true,
        className: 'trigger-outside',
        header: [
            'text:"Call frames "',
            {
                view: 'update-on-timings-change',
                data: '#.currentProfile.callFramesTimingsFiltered.entries.[entry.module = @]',
                timings: '=#.currentProfile.callFramesTimingsFiltered',
                content: 'sampled-count-total{ count(=> totalTime?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            className: 'table-content-filter',
            data: `
                #.currentProfile.callFramesTimingsFiltered.entries.[entry.module = @]
                    .zip(=> entry, #.currentProfile.codesByCallFrame, => callFrame)
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
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.callFramesTimingsFiltered',
                content: {
                    view: 'table',
                    data: `
                        .[name ~= #.filter]
                        .({
                            ...,
                            selfTime: left.selfTime,
                            nestedTime: left.nestedTime,
                            totalTime: left.totalTime
                        })
                        .sort(selfTime desc, totalTime desc, loc ascN)
                    `,
                    cols: [
                        ...timingCols,
                        {
                            header: '',
                            colWhen: '$[=>right]',
                            sorting: 'right.hotness | $ = "hot" ? 3 : $ = "warm" ? 2 : $ = "cold" ? 1 : 0 desc',
                            data: 'right',
                            contentWhen: 'hotness = "hot" or hotness = "warm"',
                            content: 'hotness-icon{ hotness, topTier }'
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
        tree: '=#.currentProfile.modulesTree',
        timings: '=#.currentProfile.modulesTreeTimingsFiltered',
        value: '='
    }
];

discovery.page.define('module', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.modules[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No module with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
