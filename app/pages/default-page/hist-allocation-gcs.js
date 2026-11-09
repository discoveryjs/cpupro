import { sessionExpandState } from '../common.js';

export const histAllocationGcs = {
    view: 'expand',
    data: `
        $expanded: "getSessionSetting".callAction("cpupro-default-allocation-gcs", false);
        $binCount: $expanded ? #.binCount : 1;
        "allocationGcEpoch".binAllocationAttribute($binCount).sort(name.order() asc)
    `,
    whenData: true,
    ...sessionExpandState('default-allocation-gcs', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation GCs"'
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
                            data: 'group(=>entry.type).({ name: key, color: value[].entry.color, value: value.sum(=>value), total: value[].total })',
                            itemConfig: {
                                view: 'labeled-value',
                                color: '=color',
                                text: '=name',
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
                : "allocationGcEpoch".binAllocationAttribute(#.binCount).sort(name.order() asc)
        `,
        item: {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.entry.color),
                    content: 'text:entry.type = "none" ? "survived" : entry.type + " #" + entry.epoch'
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
                    color: '=entry.type = "none" ? "alive".color() : entry.type = "minor" ? "short-lived".color() : "long-lived".color()'
                }
            ]
        }
    }
};
