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
        data: '{ subject: @, tree: #.currentProfile.packagesTree }'
    },

    {
        view: 'update-on-timings-change',
        timings: '=#.currentProfile.packagesTimingsFiltered',
        content: `page-indicator-timings:{
            full: #.currentProfile.packagesTimings.entries[=>entry = @],
            filtered: #.currentProfile.packagesTimingsFiltered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('package-nested-time-distribution', true),
        className: 'trigger-outside',
        header: [
            'text:"Nested time distribution"',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.packagesTimingsFiltered',
                content: 'duration:#.currentProfile.packagesTimingsFiltered.entries[=>entry=@].nestedTime'
            }
        ],
        content: `nested-timings-tree:{
            subject: @,
            tree: #.currentProfile.packagesTree,
            timings: #.currentProfile.packagesTimingsFiltered
        }`
    },

    {
        view: 'expand',
        ...sessionExpandState('package-modules', true),
        className: 'trigger-outside',
        header: [
            'text:"Modules "',
            {
                view: 'update-on-timings-change',
                data: '#.currentProfile.modulesTimingsFiltered.entries.[entry.package = @]',
                timings: '=#.currentProfile.modulesTimingsFiltered',
                content: 'sampled-count-total{ count(=> totalTime?), total: size() }'
            }
        ],
        content: {
            view: 'content-filter',
            data: `
                #.currentProfile.callFramesTimingsFiltered.entries
                    .[entry.package = @]
                    .group(=> entry.module)
                    .zip(=> key, #.currentProfile.modulesTimingsFiltered.entries, => entry)
                    .({ module: right, name: right.entry | packageRelPath or name, callFrames: left.value })
            `,
            className: 'table-content-filter',
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
                            nestedTime: module.nestedTime,
                            totalTime: module.totalTime
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
                        callFramesCol('callFrames.sort(selfTime desc, totalTime desc, entry.name ascN)')
                        // { header: 'Histogram', content: {
                        //     view: 'timeline-segments-bin',
                        //     bins: '=#.data.modulesTree.binCalls(entry, 100)',
                        //     max: '=#.data.totalTime / 100',
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
        tree: '=#.currentProfile.packagesTree',
        timings: '=#.currentProfile.packagesTreeTimingsFiltered',
        value: '='
    }
];

discovery.page.define('package', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.packages[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No package with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: pageContent }
    ]
});
