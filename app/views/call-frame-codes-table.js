discovery.view.define('call-frame-codes-table', {
    tag: false,
    render(el, props, data, context) {
        return this.render(el, [
            {
                view: 'block',
                whenData: 'no $',
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
                whenData: true,
                limit: props.limit,
                cols: [
                    {
                        header: 'Created at',
                        align: 'right',
                        data: 'tm',
                        content: 'text:formatMicrosecondsTime()'
                    },
                    {
                        header: 'Lifespan',
                        data: 'duration',
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
                        content: 'code-hotness-icon{ tier, showHint: false }'
                    },
                    {
                        header: 'Tier',
                        sorting: 'tier.order() asc',
                        data: 'tier',
                        content: [
                            'code-tier-badge',
                            'text:"\xa0" + $'
                        ]
                    },
                    {
                        header: 'Size',
                        colWhen: '.[size > 0]',
                        data: 'size',
                        align: 'right',
                        content: 'text-with-unit{ value: bytes(), unit: true }'
                    },
                    {
                        header: 'Positions',
                        data: '{ code: $, positions.parsePositions(@.size) }',
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
                            onChange: '=$mode=> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-positions-details:mode", $mode)',
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
                        header: 'Inlined',
                        data: '{ code: $, inlined.parseInlined().({ ..., callFrame: @.fns[fn] }), fns }',
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
                            onChange: '=$mode=> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-inlined-details:mode", $mode)',
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
                                        expanded: 10,
                                        data: 'inlined.tree(=>parent)',
                                        item: [
                                            'call-frame-badge:value.callFrame',
                                            {
                                                view: 'context',
                                                when: 'no parent',
                                                content: 'text:" at " + value.offset'
                                            }
                                        ]
                                    } },
                                    { when: '#.mode="table"', content: {
                                        view: 'table',
                                        data: 'inlined.({ ..., entry: parent is number ? `F${fn}O${offset}I${parent}` : `F${fn}O${offset}` })',
                                        cols: [
                                            { header: '#', data: 'index' },
                                            { header: 'Entry', sorting: 'entry ascN', content: 'text-match{ text: entry, match: /\\D+/g }' },
                                            { header: 'F (call frame)', sorting: 'callFrame.name ascN', content: 'call-frame-badge:callFrame' },
                                            { header: 'O', data: 'offset' },
                                            { header: 'I', data: 'parent' }
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
                        header: 'Deopt',
                        data: 'deopt'
                    }
                ]
            }
        ], data, context);
    }
});
