import { sessionExpandState } from '../common.js';

export const histCodes = {
    view: 'expand',
    when: '#.primaryLineType != "memline"',
    ...sessionExpandState('default-code-tiers', false, '$'),
    data: 'functionCodes',
    className: '=no $ ? "unavailable"',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Code states"'
        },
        histFunctionCodesHeader()
    ],
    content: {
        view: 'switch',
        content: [
            { when: '$', content: histFunctionCodesBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain the necessary data. Use [V8 log](https://v8.dev/docs/profile) (raw or [preprocessed](https://v8.dev/docs/profile#web-ui-for---prof)) to enable the feature."'
            } }
        ]
    }
};

function histFunctionCodesHeader() {
    return {
        view: 'switch',
        content: [
            { when: 'no $', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
            { content: [
                { view: 'block', className: 'labeled-value-groups', content: [
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '=codesTotalColor',
                            text: 'Codes',
                            value: 'text-numeric:compilations.size()'
                        },
                        {
                            view: 'labeled-value',
                            color: '=totalColor',
                            text: 'Functions',
                            value: 'text-numeric:compilations.callFrame.size()'
                        }
                    ] },
                    {
                        view: 'inline-list',
                        className: 'labeled-value-group',
                        data: 'byTier',
                        itemConfig: {
                            view: 'labeled-value',
                            color: '=color',
                            text: '=name',
                            value: 'text:100 * maxTier / maxTotal | `${toFixed(2)}%`'
                        }
                    }
                ] }
            ] }
        ]
    };
}

function histFunctionCodesBody() {
    return [
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.codesTotalColor),
                    content: 'text:"Codes"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-numeric:compilations.size()'
                },
                {
                    view: 'sample-histogram',
                    bins: '=compilationBins',
                    color: '="compilation".color()'
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
                    postRender: (el, _, data) => el.style.setProperty('--color', data.totalColor),
                    content: 'text:"Functions"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-numeric:compilations.callFrame.size()'
                },
                {
                    view: 'sample-histogram',
                    bins: '=totalBins',
                    color: '=totalColor'
                }
            ]
        },
        {
            view: 'list',
            className: 'category-timelines-list',
            data: 'byTier',
            item: {
                view: 'link',
                className: 'category-timelines-item',
                content: [
                    {
                        view: 'block',
                        className: 'label',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: 'text:name'
                    },
                    {
                        view: 'block',
                        className: 'total-percent',
                        content: 'text:100 * maxTier / maxTotal | toFixed(2)'
                    },
                    {
                        view: 'sample-histogram',
                        bins: '=bins',
                        max: '=maxTotal',
                        binsMax: true,
                        color: '=color'
                    }
                ]
            }
        }
    ];
}
