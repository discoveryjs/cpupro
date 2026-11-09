import { sessionExpandState } from '../common.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals } from './viewport-attribute-totals.js';

export const histAllocationLifespan = withViewportAttributeTotals('allocationLifespan', {
    view: 'expand',
    data: '"allocationLifespan".allocationAttributeRows().[value].sort(name.order() asc)',
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
            $bins: "allocationLifespan".binAllocationAttribute(#.binCount);
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
