const descendantTree = {
    view: 'block',
    content: [
        'h3:"Nested call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            data: `
                #.data.callFramesTreeTimingsFiltered
                    .select('nodes', @, true)
                    .[totalTime]
                    .sort(totalTime desc, selfTime desc)
            `,
            children: `
                #.data.callFramesTreeTimingsFiltered
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
                            'call-frame-loc-badge:node.value'
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
                #.data.callFramesTreeTimingsFiltered
                    .select('nodes', $, true)
                    .[totalTime]
                    .sort(totalTime desc)
            `,
            children: `
                node.parent ? #.data.callFramesTreeTimingsFiltered
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
                            'call-frame-loc-badge:node.value'
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
                'call-frame-kind-badge',
                // 'badge{ className: "type-badge", text: "Call frame" }',
                'badge{ className: "category-badge", text: module.category.name, href: module.category.marker().href, color: module.category.name.color() }',
                'package-badge',
                'badge{ text: module | packageRelPath or path or "module", href: module.marker().href }',
                'call-frame-loc-badge'
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
            data: '{ subject: @, tree: #.data.callFramesTree }'
        },

        {
            view: 'update-on-timings-change',
            timings: '=#.data.callFramesTimingsFiltered',
            content: {
                view: 'page-indicator-timings',
                data: `{
                    full: #.data.callFramesTimings.entries[=>entry = @],
                    filtered: #.data.callFramesTimingsFiltered.entries[=>entry = @]
                }`
            }
        },

        {
            view: 'expand',
            when: false,
            className: 'trigger-outside script-source',
            data: `
                #.data.scriptFunctions[=> callFrame = @]
                |? {
                    $source: callFrame.script.source or "";
                    $start: $source.lastIndexOf('\\n', callFrame.start) + 1;
                    $end: $source.indexOf('\\n', callFrame.end) | $ != -1 ?: $source.size();

                    scriptFunction: $,
                    source: $source[$start:$end],
                    $start,
                    $end
                } : {
                    callFrame: @
                }
            `,
            expanded: '=source is not undefined',
            header: [
                'text:"Source"',
                { view: 'switch', content: [
                    { when: 'callFrame.regexp', content: 'html:` \xa0<span style="color: #888">${callFrame.regexp.size().bytes(true)}</html>`' },
                    { when: 'source is not undefined', content: 'html:` \xa0<span style="color: #888">${source.size().bytes(true)}</html>`' },
                    { content: 'html:` <span style="color: #888">(unavailable)</span>`' }
                ] }
            ],
            content: [
                {
                    view: 'source',
                    className: 'regexp',
                    when: 'callFrame.regexp',
                    data: '{ content: callFrame.regexp, syntax: "regexp", lineNum: false }'
                },
                {
                    view: 'source',
                    when: 'not callFrame.regexp',
                    data: `{
                        $line: scriptFunction.callFrame.line or 1;
                        $start: scriptFunction.callFrame.start;
                        $end: scriptFunction.callFrame.end;
                        $script: scriptFunction.callFrame.script;
                        $inlinedRefs: scriptFunction.codes[-1].inlined.match(/O\\d+(?=F|$)/g).matched |
                            ? .($pos: +$[1:] - @.start; { className: 'inline', range: [$pos, $pos] })
                            : [];
                        $codePoints: scriptFunction.codes.[positions][-1].positions.match(/O\\d+(?=C|$)/g).matched |
                            ? .($pos: +$[1:] - @.start; $pos ? { className: 'code-point', range: [$pos, $pos] })
                            : [];
                        $samplePoints: #.data.callFramePositionsTimings.entries.[entry.callFrame=@.scriptFunction.callFrame] |
                            ? .($pos: entry.scriptOffset | $ != -1 ? $ - @.start : $start - @.start; [
                                // { className: 'sample-point', range: [$pos, $pos], marker: totalTime.ms() }
                                { className: 'sample-point', oo: entry.scriptOffset, range: [$pos, $pos], marker: selfTime.ms() },
                                { className: 'sample-point', oo: entry.scriptOffset, range: [$pos, $pos], marker: nestedTime.ms() }
                               ])
                            : [];
                        $tooltipView: {
                            className: 'hint-tooltip',
                            content: [
                                'text:scriptFunction.callFrame.name',
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
                                    data: 'scriptFunction.codes',
                                    item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                                }
                        ] };

                        ...,
                        syntax: "js",
                        content: source | is string ? replace(/\\n$/, "") : "// source is unavailable",
                        lineNum: => $ + $line,
                        $inlinedRefs,
                        $codePoints,
                        $samplePoints,
                        refs: $codePoints + $inlinedRefs + $samplePoints + #.data.scriptFunctions.[callFrame | script = $script and start >= $start and end <= $end].({
                            $href: @.scriptFunction != $ ? function.marker().href;
                            $marker: states | size() = 1
                                ? tier[].abbr()
                                : size() <= 3
                                    ? tier.(abbr()).join(' ')
                                    : tier[].abbr() + ' … ' + tier[-1].abbr();

                            className: 'function',
                            range: [start - @.start, end - @.start],
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
                    },
                    prelude: {
                        view: 'block',
                        when: 'scriptFunction.callFrame.script',
                        data: `
                            scriptFunction.callFrame | $start; $end; script.callFrames
                                .[start <= $start and end >= $end]
                                .sort(start asc)
                                .({
                                    target: @.scriptFunction.callFrame,
                                    callFrame: $
                                })
                        `,
                        content: {
                            view: 'inline-list',
                            className: 'function-path',
                            whenData: true,
                            item: { view: 'switch', content: [
                                { when: 'callFrame = target', content: 'block{ className: "target", content: `text:callFrame | function or $ | name or "(anonymous function)"` }' },
                                { when: 'callFrame.function', content: 'auto-link:callFrame.function' },
                                { content: 'text:callFrame | name or "(anonymous function)"' }
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
            content: 'nested-timings-tree:{ subject: @, tree: #.data.callFramesTree, timings: #.data.callFramesTimingsFiltered }'
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
                    timings: '=#.data.callFramesTimingsFiltered',
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
            tree: '=#.data.callFramesTree',
            timings: '=#.data.callFramesTreeTimingsFiltered',
            value: '='
        }
    ]
};

discovery.page.define('call-frame', {
    view: 'switch',
    data: 'callFrames[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No call frame with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        pageContent
    ]
});
