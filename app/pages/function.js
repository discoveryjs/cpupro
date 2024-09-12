const descendantTree = {
    view: 'block',
    content: [
        'h3:"Nested call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            data: `
                #.data.functionsTreeTimingsFiltered
                    .select('nodes', @, true)
                    .[totalTime]
                    .sort(totalTime desc, selfTime desc)
            `,
            children: `
                #.data.functionsTreeTimingsFiltered
                    .select('children', node.nodeIndex)
                    .[totalTime]
                    .sort(totalTime desc, selfTime desc, node.value.name ascN)
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
                #.data.functionsTreeTimingsFiltered
                    .select('nodes', $, true)
                    .[totalTime]
                    .sort(totalTime desc)
            `,
            children: `
                node.parent ? #.data.functionsTreeTimingsFiltered
                    .select('parent', node.nodeIndex)
                    .[totalTime]
                    .sort(totalTime desc)
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

const pageContent = {
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
                {
                    view: 'source',
                    when: 'regexp',
                    data: '{ content: regexp | size() <= 256 ?: `${$[:256]}…`, syntax: "regexp", lineNum: false }',
                    className: data => data.content.length > 256 ? 'too-long' : ''
                }
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
            when: false,
            className: 'trigger-outside script-source',
            data: `
                #.data.scriptFunctions[=> function = @]
                |? {
                    $source: script.source;
                    $start: $source.lastIndexOf('\\n', start) + 1;
                    $end: $source.indexOf('\\n', end) | $ != -1 ?: $source.size();

                    scriptFunction: $,
                    source: $source[$start:$end],
                    $start,
                    $end
                } : {
                    function: @
                }
            `,
            expanded: '=source is not undefined',
            header: [
                'text:"Source"',
                { view: 'switch', content: [
                    { when: 'function.regexp', content: 'html:` \xa0<span style="color: #888">${function.regexp.size().bytes(true)}</html>`' },
                    { when: 'source is not undefined', content: 'html:` \xa0<span style="color: #888">${source.size().bytes(true)}</html>`' },
                    { content: 'html:` <span style="color: #888">(unavailable)</span>`' }
                ] }
            ],
            content: [
                {
                    view: 'source',
                    className: 'regexp',
                    when: 'function.regexp',
                    data: '{ content: function.regexp, syntax: "regexp", lineNum: false }'
                },
                {
                    view: 'source',
                    when: 'not function.regexp',
                    data: `{
                        $line: scriptFunction.line or 1;
                        $start: scriptFunction.start;
                        $end: scriptFunction.end;
                        $inlinedRefs: scriptFunction.states[-1].inlined.match(/O\\d+(?=F|$)/g).matched |
                            ? .({ className: 'inline', range: [+$[1:] - @.start, +$[1:] - @.start] })
                            : [];

                        ...,
                        syntax: "js",
                        content: source | is string ? replace(/\\n$/, "") : "// source is unavailable",
                        lineNum: => $ + $line,
                        refs: $inlinedRefs + scriptFunction.script.functions.[start >= $start and end <= $end].({
                            className: 'function',
                            range: [start - @.start, end - @.start],
                            href: '#',
                            marker: states | size() = 1
                                ? tier[].abbr()
                                : size() <= 3
                                    ? tier.(abbr()).join(' ')
                                    : tier[].abbr() + ' … ' + tier[-1].abbr(),
                            tooltipData: { states, function },
                            tooltip: { className: 'hint-tooltip', content: [
                                'text:tooltipData.function.name',
                                'html:"<br>"',
                                // {
                                //     view: 'context',
                                //     data: '#.data.functionsTreeTimingsFiltered.getTimings(tooltipData.function)',
                                //     content: [
                                //         'self-time',
                                //         'nested-time',
                                //         'total-time',
                                //         'struct:node.value'
                                //     ]
                                // },
                                // 'html:"<br>"',
                                {
                                    view: 'inline-list',
                                    data: 'tooltipData.states',
                                    item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                                }
                            ] }
                        })
                    }`,
                    prelude: {
                        view: 'block',
                        when: 'scriptFunction.script',
                        data: `
                            scriptFunction | $start; $end; script.functions
                                .[start <= $start and end >= $end]
                                .sort(start asc)
                                .({
                                    target: @.scriptFunction,
                                    scriptFunction: $
                                })
                        `,
                        content: {
                            view: 'inline-list',
                            className: 'function-path',
                            whenData: true,
                            item: { view: 'switch', content: [
                                { when: 'scriptFunction = target', content: 'block{ className: "target", content: `text:scriptFunction | function or $ | name or "(anonymous function)"` }' },
                                { when: 'scriptFunction.function', content: 'auto-link:scriptFunction.function' },
                                { content: 'text:scriptFunction | name or "(anonymous function)"' }
                            ] }
                        }
                    }
                }
            ]
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
                    view: 'update-on-timings-change',
                    timings: '=#.data.functionsTimingsFiltered',
                    debounce: 150,
                    content: {
                        view: 'hstack',
                        className: 'trees',
                        content: [
                            descendantTree,
                            ancestorsTree
                        ]
                    }
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
};

discovery.page.define('function', {
    view: 'switch',
    data: 'functions[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No function with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        pageContent
    ]
});
