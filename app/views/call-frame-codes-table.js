discovery.view.define('call-frame-codes-table', {
    tag: false,
    render(el, props, data, context) {
        return this.render(el, [
            {
                view: 'block',
                when: 'no $',
                className: 'view-call-frame-source',
                content: {
                    view: 'source',
                    lineNum: false,
                    actionCopySource: false,
                    source: 'Call frame has no codes'
                }
            },
            {
                view: 'table',
                className: 'view-call-frame-codes-table',
                when: true,
                data: `.({
                    $ownerCallFrame: callFrame;
                    $fns;
                    $id: ($rec, $parsed) => $rec |
                        (parent is number ? $parsed[parent].$id($parsed) + '-' : '') +
                        offset + '-' + @.fns[fn].id;

                    code: $,
                    positions.parsePositions(size),
                    inlined.parseInlined() | $parsed: $; .({
                        ...,
                        id: $id($parsed),
                        callFrame: $fns[fn],
                        $ownerCallFrame
                    }),
                    fns
                })`,
                limit: props.limit || false,
                cols: [
                    {
                        header: 'Created at',
                        data: 'code.tm',
                        align: 'right',
                        content: 'text:formatMicrosecondsTimeFixed()'
                    },
                    {
                        header: 'Lifespan',
                        data: 'code.duration',
                        align: 'right',
                        content: {
                            view: 'switch',
                            content: [
                                { when: '$', content: 'duration' },
                                { content: 'text:"—"' }
                            ]
                        }
                    },
                    {
                        header: '',
                        content: 'code-hotness-icon{ tier: code.tier, showHint: false }'
                    },
                    {
                        header: 'Tier',
                        sorting: 'code.tier.order() asc',
                        data: 'code.tier',
                        content: [
                            'code-tier-badge',
                            'text:"\xa0" + $'
                        ]
                    },
                    {
                        header: 'Size',
                        colWhen: '.[code.size > 0]',
                        data: 'code.size',
                        align: 'right',
                        content: 'text-with-unit{ value: bytes(), unit: true }'
                    },
                    {
                        header: 'Positions table',
                        align: 'right',
                        contentWhen: 'positions',
                        content: [
                            'text:positions.size()',
                            'html:" <span style=\\"color:#888\\">blocks</span>"'
                        ],
                        details: {
                            view: 'tabs',
                            name: 'mode',
                            value: '="getSessionSetting".callAction("cpupro-call-frame-codes-table-positions-details:mode", "table")',
                            onChange: '==> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-positions-details:mode", $)',
                            tabs: [
                                'table',
                                'raw'
                            ],
                            content: {
                                view: 'switch',
                                content: [
                                    { when: '#.mode="table"', content: {
                                        view: 'table',
                                        data: 'positions.({ ..., entry: inline is number ? `C${code}O${offset}I${inline}` : `C${code}O${offset}` })',
                                        cols: [
                                            { header: '#', data: 'index' },
                                            { header: 'Entry', sorting: 'entry ascN', content: 'text-match{ text: entry, match: /\\D+/g }' },
                                            { header: 'C', data: 'code' },
                                            { header: 'O', data: 'offset' },
                                            { header: 'I', data: 'inline' },
                                            { header: 'Size', data: 'size' }
                                        ]
                                    } },
                                    { content: {
                                        view: 'block',
                                        className: 'view-call-frame-codes-table__raw-positions',
                                        content: [
                                            {
                                                view: 'source',
                                                data: 'code.positions',
                                                lineNum: false,
                                                ranges: `=
                                                    $match: ($rx, $kind) => @.match($rx, true).({ className: $kind, range: [start, end] });
                                                    /C\\d+/.$match('def') +
                                                    /O\\d+/.$match('') +
                                                    /I\\d+/.$match('ref') +
                                                    /C[^C]+/.$match('entry')
                                                `
                                            }
                                        ]
                                    } }
                                ]
                            }
                        }
                    },
                    {
                        header: 'Inlining',
                        align: 'right',
                        contentWhen: 'inlined',
                        content: [
                            'text:$fns: fns.size(); $codes: inlined.size(); $codes != $fns ? `${$fns} / ${$codes}` : $codes',
                            'html:" <span style=\\"color:#888\\">codes</span>"' // \u0192n
                        ],
                        details: {
                            view: 'tabs',
                            name: 'mode',
                            value: '="getSessionSetting".callAction("cpupro-call-frame-codes-table-inlined-details:mode", "tree")',
                            onChange: '==> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-inlined-details:mode", $)',
                            tabs: [
                                'tree',
                                'table',
                                'raw'
                            ],
                            content: {
                                view: 'switch',
                                content: [
                                    { when: '#.mode="tree"', content: {
                                        view: 'tree',
                                        className: 'inlining-tree',
                                        limitLines: false,
                                        expanded: 20,
                                        data: 'inlined.tree(=>parent).sort(value.offset asc)',
                                        children: 'children.sort(value.offset asc)',
                                        item: [
                                            'call-frame-badge:value.callFrame',
                                            {
                                                view: 'badge',
                                                className: 'source-loc',
                                                data: `
                                                    $callFrame: parent ? parent.value.callFrame : value.ownerCallFrame;
                                                    value
                                                        | offset.offsetToLineColumn($callFrame)
                                                        | is object ? \`:\${line}:\${column}\`
                                                `,
                                                whenData: true,
                                                content: 'html:replace(/:/, `<span class=\"delim\">:</span>`)'
                                            }
                                            // 'call-frame-source-point:value'
                                        ]
                                    } },
                                    { when: '#.mode="table"', content: {
                                        view: 'table',
                                        limit: false,
                                        data: 'inlined.({ ..., entry: parent is number ? `F${fn}O${offset}I${parent}` : `F${fn}O${offset}` })',
                                        cols: [
                                            { header: '#', data: 'index' },
                                            { header: 'Entry', sorting: 'entry ascN', content: 'text-match{ text: entry, match: /\\D+/g }' },
                                            { header: 'F (call frame)', sorting: 'callFrame.name ascN', content: 'call-frame-badge:callFrame' },
                                            { header: 'O', data: 'offset' },
                                            { header: 'I', data: 'parent' },
                                            { data: 'id' }
                                        ]
                                    } },
                                    { content: {
                                        view: 'block',
                                        className: 'view-call-frame-codes-table__raw-positions',
                                        content: [
                                            {
                                                view: 'source',
                                                data: 'code.inlined',
                                                lineNum: false,
                                                ranges: `=
                                                    $match: ($rx, $kind) => @.match($rx, true).({ className: $kind, range: [start, end] });
                                                    /F\\d+/.$match('def') +
                                                    /O\\d+/.$match('') +
                                                    /I\\d+/.$match('ref') +
                                                    /F[^F]+/.$match('entry')
                                                `
                                            },
                                            {
                                                view: 'struct',
                                                expanded: 1,
                                                data: 'fns'
                                            }
                                        ]
                                    } }
                                ]
                            }
                        }
                    },
                    {
                        header: 'Deoptimisations',
                        className: 'deopt',
                        contentWhen: 'code.deopt',
                        content: [
                            'badge{ prefix: code.deopt.tm.formatMicrosecondsTimeFixed(), text: code.deopt.bailoutType }',
                            'text:code.deopt.reason',
                            {
                                view: 'badge',
                                className: 'inlining-deopt',
                                when: 'code.deopt.inliningId != -1',
                                prefix: 'in inlined',
                                text: '=inlined[code.deopt.inliningId].callFrame.name'
                            },
                            {
                                view: 'badge',
                                className: 'source-loc',
                                data: `
                                    $callFrame: (code.deopt.inliningId = -1 ? code : inlined[code.deopt.inliningId]).callFrame;
                                    code.deopt
                                        | scriptOffset.offsetToLineColumn($callFrame)
                                        | is object ? \`:\${line}:\${column}\`
                                `,
                                whenData: true,
                                content: 'html:replace(/:/, `<span class=\"delim\">:</span>`)'
                            }
                        ],
                        details: {
                            view: 'tree',
                            className: 'deopt-call-stack',
                            expanded: 10,
                            data: `
                                $toTree: => [{ value: $[], children: size() > 1 ? $[1:].$toTree() }];

                                code.deopt.inliningId
                                    | $ != -1 ? $ + ..(is number ? @.inlined[$].parent) : []
                                    | reverse().(@.inlined[$] | { callFrame, offset })
                                    | inlinedPath(@.code.callFrame, @.code.deopt.scriptOffset)
                                    | $list: $; .({ ..., marks: $ = $list[-1]
                                        ? [{ offset, className: 'error', content: 'text:"deopt"' }]
                                        : [{ offset, className: 'def', content: 'text:"inline"' }]
                                    })
                                    | $toTree()
                            `,
                            item: [
                                'call-frame-badge:value',
                                {
                                    view: 'badge',
                                    className: 'source-loc',
                                    data: 'value | offset.offsetToLineColumn(callFrame) | is object ? `:${line}:${column}`',
                                    whenData: true,
                                    content: 'html:replace(/:/, `<span class=\"delim\">:</span>`)'
                                },
                                'call-frame-source-point:value'
                            ]
                        }
                    }
                ]
            }
        ], data, context);
    }
});
