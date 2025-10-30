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
                data: `$codes: $; .({
                    $ownerCallFrame: callFrame;
                    $fns;
                    $size;

                    index: $codes.indexOf($),
                    code: $,
                    positions.parsePositions($size),
                    inlined.parseInlined($fns).({
                        ...,
                        $ownerCallFrame
                    })
                })`,
                limit: props.limit || false,
                postRender: props.tablePostRender,
                cols: [
                    {
                        header: '#',
                        data: 'index'
                    },
                    {
                        header: 'Created at',
                        data: 'code.tm',
                        align: 'right',
                        content: 'text:formatMicrosecondsTimeFixed()'
                    },
                    {
                        header: 'Lifespan',
                        sorting: 'code.duration desc',
                        align: 'right',
                        content: {
                            view: 'switch',
                            data: 'code.duration',
                            content: [
                                { when: '$', content: 'duration' },
                                { content: 'text:"—"' }
                            ]
                        },
                        // detailsWhen: 'code.segments',
                        details: {
                            view: 'block',
                            className: 'code-segments',
                            content: [
                                {
                                    view: 'table',
                                    data: 'code.segments or code',
                                    cols: [
                                        {
                                            header: '#',
                                            data: '#.index + 1'
                                        },
                                        {
                                            header: 'Start at',
                                            align: 'right',
                                            data: 'tm',
                                            content: 'text:formatMicrosecondsTimeFixed()'
                                        },
                                        {
                                            header: 'Duration',
                                            align: 'right',
                                            data: 'duration',
                                            content: 'duration'
                                        }
                                    ]
                                },
                                {
                                    view: 'block',
                                    className: 'time-ruler-wrapper',
                                    content: [
                                        {
                                            view: 'time-ruler',
                                            labels: 'top',
                                            duration: '=#.data.currentProfile.totalTime'
                                        },
                                        {
                                            view: 'list',
                                            data: '$color: code.tier.color(true); (code.segments or code).({ ..., $color })',
                                            itemConfig: {
                                                view: 'block',
                                                className: 'segment',
                                                postRender(el, _, data, context) {
                                                    const total = context.data.currentProfile.totalTime;

                                                    el.style.setProperty('--index', context.index);
                                                    el.style.setProperty('--color', data.color);
                                                    el.style.setProperty('--tm', data.tm / total);
                                                    el.style.setProperty('--duration', data.duration / total);
                                                }
                                            }
                                        }
                                    ]
                                }
                            ]
                        }
                    },
                    {
                        header: '',
                        content: 'code-hotness-icon{ tier: code.tier, showHint: false }'
                    },
                    {
                        header: 'Compiler',
                        sorting: 'code.tier.order() asc',
                        data: 'code',
                        content: [
                            'code-tier-badge:tier',
                            'text:`\xa0${tier}\xa0`',
                            'badge{ when: specialized, text: "(S)", tooltip: "text:`Context specialized code`" }'
                        ]
                    },
                    {
                        header: 'Code',
                        colWhen: '.[code.size > 0]',
                        sorting: 'code.size desc',
                        align: 'right',
                        content: ['text-with-unit{ value: code.size.bytes(), unit: true }'],
                        detailsWhen: 'code.disassemble',
                        details: 'code-disassemble-viewer:code'
                    },
                    {
                        header: 'Position table',
                        align: '=positions ? "right" : "center"',
                        colSpan: '=no positions and no inlined ? 2 : 1',
                        contentWhen: 'positions or (no positions and no inlined)',
                        content: {
                            view: 'switch',
                            content: [
                                { when: 'positions', content: [
                                    'text:positions.size()',
                                    'html:" <span style=\\"color:#888\\">blocks</span>"'
                                ] },
                                { content: 'html:"<span style=\\"color:#555;font-style:italic\\">missed in V8 log</span>"' }
                            ]
                        },
                        detailsWhen: 'positions',
                        details: 'code-positions-table-viewer:code'
                    },
                    {
                        header: 'Inlining',
                        when: 'positions or inlined',
                        align: 'right',
                        contentWhen: 'inlined',
                        content: [
                            'text:$locs: inlined.count(=>no parent?); $codes: inlined.size(); $codes != $locs ? `${$locs} / ${$codes}` : $codes',
                            'html:" <span style=\\"color:#888\\">codes</span>"' // \u0192n
                        ],
                        details: 'code-inline-table-viewer:code'
                    },
                    {
                        header: 'Inline cache',
                        colWhen: 'code.ic',
                        data: 'code.ic'
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
                                text: '=inlined[code.deopt.inliningId] |? callFrame.name : "(unavailable)"'
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
                            view: 'switch',
                            content: [
                                { when: 'code.deopt | inliningId = -1 or @.inlined[inliningId]', content: {
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
                                } },
                                { content: 'html:"<div style=\\"color: #888;padding: 4px 8px\\">Details unavailable because of missed inlining data for the code in V8 log</div>"' }
                            ]
                        }
                    }
                ]
            }
        ], data, context);
    }
});
