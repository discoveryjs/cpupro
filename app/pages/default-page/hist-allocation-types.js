import { sessionExpandState } from '../common.js';

export const histAllocationTypes = {
    view: 'expand',
    data: 'memline.byType.[value].sort(value desc)', // .sort(name.order() asc)
    whenData: true,
    ...sessionExpandState('default-allocation-types', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation types"'
        },
        {
            view: 'switch',
            content: [
                { when: 'no $', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
                { content: [
                    { view: 'block', className: 'labeled-value-groups', content: [
                        {
                            view: 'inline-list',
                            className: 'labeled-value-group',
                            limit: false,
                            itemConfig: {
                                view: 'labeled-value',
                                color: '=color or entry.colorRand()',
                                text: '=entry',
                                value: 'text:100 * value / total | `${toFixed(2)}%`'
                            }
                        }
                    ] }
                ] }
            ]
        }
    ],
    content: {
        view: 'list',
        className: 'category-timelines-list',
        limit: 10,
        item: {
            view: 'link',
            className: 'category-timelines-item',
            data: '{ ..., color: color or entry.colorRand() }',
            content: [
                {
                    view: 'block',
                    className: 'label allocation-type-label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                    content: {
                        view: 'block',
                        className: 'text',
                        content: 'text:entry.replace(/\\(\\d+\\)\\s*/, "")',
                        tooltip: 'text:entry'
                    }
                },
                {
                    view: 'block',
                    className: 'total-percent',
                    content: 'text:100 * value / total | toFixed(2)'
                },
                {
                    view: 'sample-histogram',
                    bins: '=bins',
                    max: '=max',
                    scale: '=step ? "linear" : "sqrt"',
                    binsMax: true,
                    color: '=color'
                }
            ]
        }
    }
};
