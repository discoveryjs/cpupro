import { sessionExpandState } from '../common.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals } from './viewport-attribute-totals.js';

export const histAllocationCodeType = withViewportAttributeTotals('allocationCodeType', {
    view: 'expand',
    data: '"allocationCodeType".allocationAttributeRows().[value].sort(name.order() asc)',
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
                            view: 'update-on-line-metrics-changes',
                            metrics: '=#.viewportTotals',
                            debounce: true,
                            content: {
                                view: 'inline-list',
                                className: 'labeled-value-group',
                                itemConfig: {
                                    view: 'labeled-value',
                                    color: '=color',
                                    text: '=entry',
                                    value: `text:${viewportShare} | \`\${toFixed(2)}%\``
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
            $bins: "allocationCodeType".binAllocationAttribute(#.binCount);
            .($track: $bins[index]; { ..., bins: $track.bins, max: $track.max, step: $track.step })
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
                    content: viewportShareText()
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
});
