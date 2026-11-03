import { sessionExpandState } from '../common.js';

export const histAllocationLifespan = {
    view: 'expand',
    data: `
        $expanded: "getSessionSetting".callAction("cpupro-default-allocation-lifespans", false);
        $binCount: $expanded ? #.binCount : 1;
        "allocationLifespan".binAllocationAttribute($binCount).[value].sort(name.order() asc)
    `,
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
    rulerDetails: {
        view: 'block',
        className: 'details-section',
        context: '{ ...#, scopeViewport: #.detail }',
        data: `
            $rows: "allocationLifespan".binAllocationAttribute(1).[value];
            $total: $rows.sum(=>value);
            $rows.({ entry, color, value, total: $total })
        `,
        whenData: true,
        content: [
            {
                view: 'block',
                className: 'details-section-title',
                content: 'text:"Allocation lifespans"'
            },
            {
                view: 'list',
                className: 'category-timings-list',
                itemConfig: {
                    postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                    content: [
                        'block{ className: "category-name", content: "text:entry" }',
                        'value-fraction{ value: value.bytes(), fraction: value / total }'
                    ]
                }
            }
        ]
    },
    content: {
        view: 'list',
        className: 'category-timelines-list',
        data: `
            $[].bins.size() = #.binCount ? $
                : "allocationLifespan".binAllocationAttribute(#.binCount).[value].sort(name.order() asc)
        `,
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
                    view: 'line-histogram',
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
