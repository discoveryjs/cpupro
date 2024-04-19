const descendantTree = {
    view: 'block',
    content: [
        'h3:"Subtree"',
        {
            view: 'tree',
            className: 'call-tree',
            data: `
                #.data.functionsTreeTimings.select('nodes', @, true)
                | sort(totalTime desc, selfTime desc)
            `,
            children: `
                #.data.functionsTreeTimings.select('children', node.nodeIndex)
                | sort(totalTime desc, selfTime desc, node.value.name ascN)
            `,
            item: {
                view: 'context',
                content: [
                    {
                        view: 'switch',
                        content: [
                            { when: 'node.value.id = +#.id', content: {
                                view: 'block',
                                className: 'self',
                                content: 'text:node.value.name'
                            } },
                            { content: 'auto-link:node.value' }
                        ]
                    },
                    { view: 'text', when: 'subtreeSize', data: '` (${subtreeSize}) `' },
                    {
                        view: 'block',
                        className: 'grouped',
                        data: 'grouped.size()',
                        whenData: '$ > 1',
                        content: 'text:"×" + $'
                    },
                    {
                        view: 'self-time'
                    },
                    {
                        view: 'nested-time',
                        data: 'nestedTime',
                        whenData: true
                    },
                    // { view: 'total-time', when: 'children', data: 'totalTime' },
                    {
                        view: 'context',
                        when: 'node.value.id != +#.id',
                        content: [
                            'module-badge:node.value',
                            'loc-badge:node.value'
                        ]
                    }
                ]
            }
        }
    ]
};

const ancestorsTree = {
    view: 'block',
    content: [
        'h3:"Ancestor call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            expanded: 3,
            data: `
                #.data.functionsTreeTimings.select('nodes', $, true)
                | sort(totalTime desc)
            `,
            children: `
                node.parent ? #.data.functionsTreeTimings.select('parent', node.nodeIndex)
                | sort(totalTime desc)
            `,
            item: {
                view: 'context',
                content: [
                    {
                        view: 'switch',
                        content: [
                            { when: 'node.value.id = +#.id', content: {
                                view: 'block',
                                className: 'self',
                                content: 'text:node.value.name'
                            } },
                            { content: 'auto-link:node.value' }
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
                        view: 'total-time'
                    },
                    {
                        view: 'context',
                        when: 'node.value.id != +#.id',
                        content: [
                            'module-badge:node.value',
                            'loc-badge:node.value'
                        ]
                    }
                ]
            }
        }
    ]
};

discovery.page.define('function', {
    view: 'context',
    data: 'functions[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Function" }',
                'badge{ className: "category-badge", text: module.category.name, href: module.category.marker().href, color: module.category.name.color() }',
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
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.functionsTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.functionsTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.functionsTimings.entries[=>entry = @],
                    filtered: #.data.functionsTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Nested time distribution"',
            content: 'nested-timings-tree:{ subject: @, tree: #.data.functionsTree, timings: #.data.functionsTimingsFiltered }'
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
                view: 'expand',
                expanded: true,
                className: 'trigger-outside',
                header: 'text:"Call trees"',
                content: {
                    view: 'hstack',
                    className: 'trees',
                    content: [
                        descendantTree,
                        ancestorsTree
                    ]
                }
            }
        },

        {
            view: 'flamechart-expand',
            tree: '=#.data.functionsTree',
            timings: '=#.data.functionsTreeTimingsFiltered',
            value: '='
        }
    ]
});
