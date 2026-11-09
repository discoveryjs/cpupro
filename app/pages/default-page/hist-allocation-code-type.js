import { sessionExpandState } from '../common.js';

export const histAllocationCodeType = {
    view: 'expand',
    data: `
        $expanded: "getSessionSetting".callAction("cpupro-default-allocation-code-types", false);
        $binCount: $expanded ? #.binCount : 1;
        "allocationCodeType".binAllocationAttribute($binCount).[value].sort(name.order() asc)
    `,
    whenData: true,
    ...sessionExpandState('default-allocation-code-types', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation code types"'
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
        data: `
            $[].bins.size() = #.binCount ? $
                : "allocationCodeType".binAllocationAttribute(#.binCount).[value].sort(name.order() asc)
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
                    zoom: true,
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
