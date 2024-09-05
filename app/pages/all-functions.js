discovery.page.define('functions', [
    {
        view: 'page-header',
        prelude: [
            'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
            'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
            'badge{ text: "Functions", className: #.page = "functions" ? "selected", href: #.page != "functions" ? "#functions" }'
        ],
        content: 'h1:"All functions"'
    },

    {
        view: 'content-filter',
        content: [
            {
                view: 'table',
                data: `
                    functionsTimings.entries.zip(scriptFunctions, => entry, => function)
                        .[left.entry.name ~= #.filter]
                        .sort(left.selfTime desc, left.totalTime desc)
                        .({
                            ...,
                            name: left.entry.name,
                            moduleName: left.entry.module.name,
                            loc: left.entry.loc
                        })
                `,
                cols: [
                    { header: 'Self time',
                        data: 'left',
                        colSpan: '=totalTime ? 1 : 3',
                        sorting: 'left.selfTime desc, left.totalTime desc',
                        content: {
                            view: 'switch',
                            content: [
                                { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                { content: 'no-samples' }
                            ]
                        }
                    },
                    { header: 'Nested time',
                        data: 'left',
                        when: 'left.totalTime',
                        sorting: 'left.nestedTime desc, left.totalTime desc',
                        content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                    },
                    { header: 'Total time',
                        data: 'left',
                        when: 'left.totalTime',
                        sorting: 'left.totalTime desc, left.selfTime desc',
                        content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                    },
                    { header: 'Kind',
                        data: 'left.entry',
                        content: 'function-kind-badge:kind'
                    },
                    // { header: 'Function',
                    //     data: 'left.entry',
                    //     sorting: 'name ascN',
                    //     content: {
                    //         view: 'auto-link',
                    //         content: 'text-match:{ text, match: #.filter }'
                    //     }
                    // },
                    { header: 'Function', data: 'left.entry', sorting: 'name ascN', content: {
                        view: 'badge',
                        data: 'marker() | { text: title, href, match: #.filter }',
                        content: 'text-match'
                    } },
                    { header: 'Module',
                        data: 'left.entry',
                        sorting: 'moduleName ascN, loc ascN',
                        content: [
                            'module-badge:module',
                            'loc-badge'
                        ]
                    },
                    { header: 'Source',
                        data: 'right',
                        sorting: '(right.end - right.start) desc',
                        content: 'text:end - start | $ > 0?: ""',
                        details: '=end-start > 0 ? `source:{ syntax: "js", content: script.source[start:end] }`'
                    },
                    { header: 'States',
                        data: 'right',
                        sorting: 'right.states.size() desc',
                        content: { view: 'inline-list', whenData: true, data: 'states.([[tier.abbr() + "\xa0"]])' }
                    }
                ]
            }
        ]
    }
]);
