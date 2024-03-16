discovery.page.define('function', {
    view: 'context',
    data: 'functions[=>id = +#.id]',
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
            view: 'subject-with-nested-timeline',
            data: '{ subject: @, tree: #.data.functionsTree }'
        },

        {
            view: 'page-indicator-timings',
            data: '#.data.functionsTimings.entries[=>entry = @]'
        },

        {
            view: 'tree',
            data: `
                $functions: #.data.functionsTree.nestedTimings($);
                $totalTime: $functions.sum(=>selfTime);

                $functions
                    .({ function: entry, time: selfTime, total: $totalTime })
                    .sort(time desc)
                    .group(=>function.module)
                        .({ module: key, time: value.sum(=>time), total: $totalTime, functions: value })
                        .sort(time desc)
                    .group(=>module.package)
                        .({ package: key, time: value.sum(=>time), total: $totalTime, modules: value })
                        .sort(time desc)
            `,
            expanded: false,
            itemConfig: {
                content: ['package-badge:package', 'duration'],
                children: 'modules',
                itemConfig: {
                    content: ['module-badge:module', 'duration'],
                    children: 'functions',
                    itemConfig: {
                        content: ['function-badge:function', 'duration']
                    }
                }
            }
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
                                    | sort(totalTime desc, selfTime desc, host.name ascN)
                                    #.data.functionsTree.select('nodes', $, true)
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
                                        { view: 'text', when: 'subtreeSize', data: '` (${subtreeSize}) `' },
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
                                    | sort(totalTime desc)
                                    #.data.functionsTree.select('nodes', $, true)
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
