discovery.view.define('call-frame-codes-table', [
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
        whenData: true,
        limit: { start: 5, tolerance: 3, base: false },
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
                data: 'positions.match(/C[^C]+/g).matched',
                align: 'right',
                contentWhen: '$',
                content: [
                    'text:size()',
                    'html:" <span style=\\"color:#888\\">blocks</span>"'
                ],
                details: {
                    view: 'table',
                    data: '.(split(/\\D/) | { code: +$[1], offset: +$[2], inline: $[3] | is string ? +$ })'
                }
            },
            {
                header: 'Inlined',
                align: 'right',
                contentWhen: 'inlined',
                content: [
                    'text:$fns: fns.size(); $codes: inlined.match(/F/g).size(); $codes != $fns ? `${$fns} / ${$codes}` : $codes',
                    'html:" <span style=\\"color:#888\\">codes</span>"' // \u0192n
                ],
                details: [
                    {
                        view: 'table',
                        data: `
                            $entries: inlined.match(/F[^F]+/g).matched.(split(/\\D/) | {
                                fn: +$[1],
                                offset: +$[2],
                                parent: $[3] | is string ? +$
                            });

                            $entries.({
                                ...,
                                callFrame: @.fns[fn]
                            })
                        `,
                        cols: {
                            callFrame: { header: 'Call frame', content: 'call-frame-badge:callFrame' }
                        }
                    },
                    'struct:fns'
                ]
            },
            {
                header: 'Deopt',
                data: 'deopt'
            }
        ]
    }
]);
