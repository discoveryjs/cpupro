const pageContent = {
    content: [
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
            data: '{ subject: @, tree: #.data.modulesTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.modulesTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.modulesTimings.entries[=>entry = @],
                    filtered: #.data.modulesTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            when: false,
            className: 'trigger-outside script-source',
            data: '#.data.scripts[=> module = @]',
            expanded: '=source is not undefined',
            header: [
                'text:"Source"',
                { view: 'switch', content: [
                    { when: 'source is not undefined', content: 'html:` \xa0<span style="color: #888">${source.size().bytes(true)}</html>`' },
                    { content: 'html:` <span style="color: #888">(unavailable)</span>`' }
                ] }
            ],
            content: {
                view: 'source',
                data: `{
                    $tooltipView: [
                        'text:scriptFunction.name',
                        'html:"<br>"',
                        {
                            view: 'inline-list',
                            data: 'scriptFunction.states',
                            item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                        }
                    ];

                    syntax: "js",
                    content: source | is string ? replace(/\\n$/, "") : "// source is unavailable",
                    refs: functions.({
                        $href: function.marker().href;
                        $marker: states | size() = 1
                            ? tier[].abbr()
                            : size() <= 3
                                ? tier.(abbr()).join(' ')
                                : tier[].abbr() + ' … ' + tier[-1].abbr();

                        className: 'function',
                        range: [start, end],
                        marker: $href ? $marker + '" data-href="' + $href : $marker,
                        scriptFunction: $,
                        tooltip: $tooltipView
                    })
                }`,
                postRender(el) {
                    const contentEl = el.querySelector('.view-source__content');

                    contentEl.addEventListener('click', (event) => {
                        const pseudoLinkEl = event.target.closest('.view-source .spotlight[data-href]');

                        if (pseudoLinkEl && contentEl.contains(pseudoLinkEl)) {
                            discovery.setPageHash(pseudoLinkEl.dataset.href);
                        }
                    });
                }
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Nested time distribution"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.modulesTree, timings: #.data.modulesTimingsFiltered }'
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: [
                'text:"Functions "',
                {
                    view: 'pill-badge',
                    data: '#.data.functionsTimingsFiltered.entries.[entry.module = @]',
                    content: [
                        {
                            view: 'update-on-timings-change',
                            timings: '=#.data.functionsTimingsFiltered',
                            content: 'text-numeric:count(=> totalTime?)'
                        },
                        {
                            view: 'text-numeric',
                            className: 'total-number',
                            data: '` ⁄ ${size()}`'
                        }
                    ]
                }
            ],
            content: {
                view: 'content-filter',
                className: 'table-content-filter',
                data: `
                    #.data.functionsTimingsFiltered.entries.[entry.module = @]
                        .zip(=> entry, #.data.scriptFunctions, => function)
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
                    timings: '=#.data.functionsTimingsFiltered',
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
                            { header: 'Self time',
                                sorting: 'selfTime desc, totalTime desc, loc ascN',
                                colSpan: '=totalTime ? 1 : 3',
                                content: {
                                    view: 'switch',
                                    content: [
                                        { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                        { content: 'no-samples' }
                                    ]
                                }
                            },
                            { header: 'Nested time',
                                sorting: 'nestedTime desc, totalTime desc, loc ascN',
                                when: 'totalTime',
                                content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                            },
                            { header: 'Total time',
                                sorting: 'totalTime desc, selfTime desc, loc ascN',
                                when: 'totalTime',
                                content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                            },
                            { header: 'Function',
                                sorting: 'name ascN',
                                content: 'auto-link{ data: entry, content: "text-match:{ ..., match: #.filter }" }'
                            },
                            { header: 'Loc',
                                sorting: 'loc ascN',
                                data: 'entry',
                                content: ['module-badge', 'loc-badge']
                            }
                        ]
                    }
                }
            }
        },

        {
            view: 'flamechart-expand',
            tree: '=#.data.modulesTree',
            timings: '=#.data.modulesTreeTimingsFiltered',
            value: '='
        }
    ]
};

discovery.page.define('module', {
    view: 'switch',
    data: 'modules[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No module with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        pageContent
    ]
});
