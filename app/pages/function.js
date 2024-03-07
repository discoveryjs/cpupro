discovery.page.define('function', {
    view: 'context',
    data: 'functionsTree.dictionary[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Function" }',
                'badge{ className: "area-badge", text: module.area.name, href: module.area.marker().href, color: module.area.name.color() }',
                'package-badge',
                'badge{ text: module | packageRelPath or path or "module", href: module.marker().href }',
                'loc-badge'
            ],
            content: [
                { view: 'h1', when: 'not regexp', data: 'name' },
                { view: 'source', when: 'regexp', data: '{ content: regexp, syntax: "regexp", lineNum: false }' }
            ]
        },

        {
            view: 'block',
            className: 'subject-timeline',
            content: [
                'time-ruler{ duration: #.data.totalTime, captions: "top" }',
                {
                    view: 'timeline-segments-bin',
                    bins: '=binCalls(#.data.functionsTree, $, 500)',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=module.area.name.color()',
                    height: 30
                }
            ]
        },

        {
            view: 'block',
            className: 'indicators',
            content: [
                {
                    view: 'page-indicator',
                    title: 'Self time',
                    value: '=selfTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Self time, %',
                    value: '=selfTime.totalPercent()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time',
                    value: '=totalTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time, %',
                    value: '=totalTime.totalPercent()',
                    unit: true
                }
            ]
        },

        {
            view: 'context',
            modifiers: [
                // {
                //     view: 'checkbox',
                //     name: 'groupByRef',
                //     checked: true,
                //     content: 'text:"Group call sites"'
                // }
            ],
            content: {
                view: 'hstack',
                className: 'trees',
                content: [
                    {
                        view: 'block',
                        content: [
                            'h2:"Subtree"',
                            {
                                view: 'tree',
                                data: `
                                    #.data.functionsTree.select('nodes', $)
                                    | sort(totalTime desc, selfTime desc, host.name ascN)
                                `,
                                children: `
                                    children
                                    | sort(totalTime desc, selfTime desc, host.name ascN)
                                `,
                                item: {
                                    view: 'context',
                                    content: [
                                        {
                                            view: 'switch',
                                            content: [
                                                { when: 'host.id = +#.id', content: {
                                                    view: 'block',
                                                    className: 'self',
                                                    content: 'text:host.name'
                                                } },
                                                { content: 'auto-link:host' }
                                            ]
                                        },
                                        {
                                            view: 'block',
                                            className: 'grouped',
                                            data: 'grouped.size()',
                                            whenData: '$ > 1',
                                            content: 'text:"×" + $'
                                        },
                                        {
                                            view: 'self-time',
                                            tooltip: {
                                                showDelay: true,
                                                className: 'hint-tooltip',
                                                content: 'text:"Self time – the time spent on executing the code of a function, not counting the time taken by other functions that it might call"'
                                            }
                                        },
                                        {
                                            view: 'nested-time',
                                            when: 'children',
                                            data: 'totalTime - selfTime',
                                            tooltip: {
                                                showDelay: true,
                                                className: 'hint-tooltip',
                                                content: 'text:"Nested time – the time accounted for the execution of other functions that are called from within a given function, but not including the time it takes to run the original function\'s own code"'
                                            }
                                        },
                                        // { view: 'total-time', when: 'children', data: 'totalTime' },
                                        'module-badge:host',
                                        'loc-badge:host'
                                    ]
                                }
                            }
                        ]
                    },

                    {
                        view: 'block',
                        content: [
                            'h2:"Ancestor call sites"',
                            {
                                view: 'tree',
                                expanded: 3,
                                data: `
                                    #.data.functionsTree.select('nodes', $)
                                    | sort(totalTime desc)
                                `,
                                children: `
                                    parent ? [parent]
                                    | sort(totalTime desc)
                                `,
                                item: {
                                    view: 'context',
                                    content: [
                                        {
                                            view: 'switch',
                                            content: [
                                                { when: 'host.id = +#.id', content: {
                                                    view: 'block',
                                                    className: 'self',
                                                    content: 'text:host.name'
                                                } },
                                                { content: 'auto-link:host' }
                                            ]
                                        },
                                        {
                                            view: 'block',
                                            className: 'grouped',
                                            data: 'grouped.size()',
                                            whenData: '$ > 1',
                                            content: 'text:"×" + $'
                                        },
                                        {
                                            view: 'total-time',
                                            tooltip: {
                                                showDelay: true,
                                                className: 'hint-tooltip',
                                                content: 'text:"Total time – the entire duration spent on the execution of a function. This includes both the \'self time\', which is the time taken by the function itself to execute its own code, and the \'nested time\', which is the time spent on executing all the other functions that are called from within this function"'
                                            }
                                        },
                                        'module-badge:host',
                                        'loc-badge:host'
                                    ]
                                }
                            }
                        ]
                    }
                ]
            }
        }
    ]
});
