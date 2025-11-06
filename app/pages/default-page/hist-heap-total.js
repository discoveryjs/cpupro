import { sessionExpandState } from '../common.js';

export const histHeapTotal = {
    view: 'expand',
    when: '#.primaryLineType != "memline"',
    ...sessionExpandState('default-timelines-heap', false, '$'),
    data: 'heap',
    className: '=no $ ? "unavailable"',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Heap size"'
        },
        histHeapTotalHeader()
    ],
    content: {
        view: 'switch',
        content: [
            { when: '$', content: histHeapTotalBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain the necessary data. Use [V8 log](https://v8.dev/docs/profile) (raw) to enable the feature."'
            } }
        ]
    }
};

function histHeapTotalHeader() {
    return {
        view: 'switch',
        content: [
            { when: 'no $', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
            { content: [
                { view: 'block', className: 'labeled-value-groups', content: [
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '#5b88c6',
                            text: 'Total size',
                            value: [
                                'text-numeric:minTotal.bytes()',
                                {
                                    view: 'context',
                                    when: 'minTotal != maxTotal',
                                    content: [
                                        'text:" … "',
                                        'text-numeric:maxTotal.bytes()'
                                    ]
                                }
                            ]
                        },
                        {
                            view: 'labeled-value',
                            when: 'available',
                            text: 'Limit',
                            value: 'text-numeric:available.bytes(false, 1024)'
                        }
                    ] },
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '#bf8354',
                            text: 'Allocated',
                            value: 'text-numeric:newTotal.bytes()'
                        },
                        {
                            view: 'labeled-value',
                            color: '#80a556',
                            text: 'Released',
                            value: 'text-numeric:deleteTotal.bytes()'
                        }
                    ] }
                ] }
            ] }
        ]
    };
}

function histHeapTotalBody() {
    return [
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el) => el.style.setProperty('--color', '#5b88c6'),
                    content: 'text:"Total size"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: [
                        'text-with-unit{ value: maxTotal.bytes(false), unit: true }',
                        'text-with-unit{ value: minTotal.bytes(), unit: true }'
                    ]
                },
                {
                    view: 'sample-histogram',
                    className: 'mem-bins',
                    height: 36,
                    data: 'totalHeapSize',
                    bins: '=$',
                    // max: '=max() | $ < 20_000_000 ?: 20_000_000',
                    binsMax: true,
                    color: '#5b88c6'
                }
            ]
        },
        {
            color: '#bf8354',
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    content: 'text:"Allocations"',
                    postRender: (el) => el.style.setProperty('--color', '#bf8354')
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-with-unit{ value: newTotal.bytes(false), unit: true }'
                },
                {
                    view: 'sample-histogram',
                    className: 'mem-bins',
                    bins: '=new',
                    max: '=maxNewDelete',
                    binsMax: true,
                    color: '#bf8354'
                }
            ]
        },
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    content: 'text:"Releases"',
                    postRender: (el) => el.style.setProperty('--color', '#80a556')
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-with-unit{ value: deleteTotal.bytes(false), unit: true }'
                },
                {
                    view: 'sample-histogram',
                    className: 'mem-bins heap-delete-chunks',
                    bins: '=delete',
                    max: '=maxNewDelete',
                    binsMax: true,
                    color: '#80a556'
                }
            ]
        }
    ];
}
