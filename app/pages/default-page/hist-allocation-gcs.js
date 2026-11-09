import { sessionExpandState } from '../common.js';
import { viewportShareText, withViewportAttributeTotals } from './viewport-attribute-totals.js';

export const histAllocationGcs = withViewportAttributeTotals('allocationGcEpoch', {
    view: 'expand',
    data: '"allocationGcEpoch".allocationAttributeRows().sort(name.order() asc)',
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
                            view: 'update-on-line-metrics-changes',
                            metrics: '=#.viewportTotals',
                            debounce: true,
                            content: {
                                view: 'inline-list',
                                className: 'labeled-value-group',
                                data: `
                                    $viewport: #.viewportTotals.value;
                                    group(=> entry.type).({
                                        name: key,
                                        color: value[].entry.color,
                                        value: value.sum(=> $viewport.tracks[index].value),
                                        total: $viewport.total
                                    })
                                `,
                                itemConfig: {
                                    view: 'labeled-value',
                                    color: '=color',
                                    text: '=name',
                                    value: 'text:total ? 100 * value / total : 0 | `${toFixed(2)}%`'
                                }
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
            $bins: "allocationGcEpoch".binAllocationAttribute(#.binCount);
            .($track: $bins[index]; { ..., bins: $track.bins, max: $track.max, step: $track.step })
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
                    content: viewportShareText()
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
});
