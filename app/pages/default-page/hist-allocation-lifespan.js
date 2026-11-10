import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals } from './scope-values.js';

export const histAllocationLifespan = withViewportAttributeTotals('allocationLifespan', {
    view: 'expand',
    data: '"allocationLifespan".allocationAttributeRows().[value]',
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
    content: withLineWindowValue('attributeBins', '"allocationLifespan".binAllocationAttribute(#.binCount)', {
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
                    content: viewportShareText()
                },
                lineWindowHistogram('attributeBins', '$track: #.attributeBins.value[index]; { ..., bins: $track.bins, totalBins: $track.totalBins, step: $track.step }', {
                    bins: '=bins',
                    scaleBins: '=[totalBins]',
                    binsMax: true,
                    scale: '=step ? "linear" : "sqrt"',
                    color: '=color'
                })
            ]
        }
    })
});
