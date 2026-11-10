import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals } from './scope-values.js';

export const histAllocationCodeType = withViewportAttributeTotals('allocationCodeType', {
    view: 'expand',
    data: '"allocationCodeType".allocationAttributeRows().[value]',
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
    content: withLineWindowValue('attributeBins', '"allocationCodeType".binAllocationAttribute(#.binCount)', {
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
