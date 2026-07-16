import { sessionExpandState } from '../common.js';

export const histAllocationLifespan = {
    view: 'expand',
    data: 'memline.byLifespan.[value].sort(name.order() asc)',
    whenData: true,
    ...sessionExpandState('default-allocation-lifespans', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation lifespans"'
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
                            itemConfig: {
                                view: 'labeled-value',
                                color: '=color',
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
        item: {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                    content: 'text:entry'
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
                    binsMax: true,
                    scale: '=step ? "linear" : "sqrt"',
                    color: '=color'
                }
            ]
        }
    }
};
