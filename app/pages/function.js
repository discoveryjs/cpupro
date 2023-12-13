discovery.page.define('function', {
    view: 'context',
    data: 'functions[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Function" }',
                'module-badge'
            ],
            content: [
                'h1:name',
                'package-badge{ when: package.type = "npm" }',
                {
                    view: 'text',
                    when: 'loc',
                    data: 'loc'
                }
            ]
        },

        'timeline-segments:calls.segments',

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
                {
                    view: 'checkbox',
                    name: 'groupByRef',
                    checked: true,
                    content: 'text:"Group call sites"'
                }
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
                                    calls
                                    | (not #.groupByRef ?: groupByCallSiteRef())
                                    | sort(totalTime desc)
                                `,
                                children: `
                                    children
                                    | (not #.groupByRef ?: groupByCallSiteRef())
                                    | sort(totalTime desc)
                                `,
                                item: {
                                    view: 'context',
                                    content: [
                                        {
                                            view: 'switch',
                                            content: [
                                                { when: '(function.id or to.id or id) = +#.id', content: {
                                                    view: 'block',
                                                    className: 'self',
                                                    content: 'text:function or $ | name'
                                                } },
                                                { content: 'auto-link:function or to or $' }
                                            ]
                                        },
                                        {
                                            view: 'block',
                                            className: 'grouped',
                                            data: 'grouped.size()',
                                            whenData: '$ > 1',
                                            content: 'text:"×" + $'
                                        },
                                        'self-time',
                                        { view: 'nested-time', when: 'children', data: 'totalTime - selfTime' },
                                        // { view: 'total-time', when: 'children', data: 'totalTime' },
                                        'module-badge',
                                        'loc-badge'
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
                                    calls
                                    | (not #.groupByRef ?: groupByCallSiteRef())
                                    | sort(totalTime desc)
                                `,
                                children: `
                                    grouped or [$]
                                    | .(parent or [])
                                    | (not #.groupByRef ?: groupByCallSiteRef())
                                    | sort(totalTime desc)
                                `,
                                item: {
                                    view: 'context',
                                    content: [
                                        {
                                            view: 'switch',
                                            content: [
                                                { when: '(function.id or to.id or id) = +#.id', content: {
                                                    view: 'block',
                                                    className: 'self',
                                                    content: 'text:function or $ | name'
                                                } },
                                                { content: 'auto-link:function or to or $' }
                                            ]
                                        },
                                        {
                                            view: 'block',
                                            className: 'grouped',
                                            data: 'grouped.size()',
                                            whenData: '$ > 1',
                                            content: 'text:"×" + $'
                                        },
                                        'total-time',
                                        'module-badge',
                                        'loc-badge'
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
