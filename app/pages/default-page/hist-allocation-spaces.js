import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals, viewportTrackScales } from './scope-values.js';

export const histAllocationSpaces = withViewportAttributeTotals('allocationSpace', {
    view: 'expand',
    data: '"allocationSpace".allocationAttributeRows().[value]',
    whenData: true,
    ...sessionExpandState('default-allocation-spaces', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation spaces"'
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
                                    text: '=entry.name',
                                    value: `text:${viewportShare} | \`\${toFixed(2)}%\``
                                }
                            }
                        }
                    ] }
                ] }
            ]
        }
    ],
    content: withLineWindowValue('attributeBins', '"allocationSpace".binAllocationAttribute(#.binCount)', {
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
                    content: 'text:entry.name'
                },
                {
                    view: 'block',
                    className: 'total-percent',
                    content: viewportShareText()
                },
                lineWindowHistogram('attributeBins', '$track: #.attributeBins.value[index]; { ..., bins: $track.bins, totalBins: $track.totalBins, step: $track.step }', {
                    bins: '=bins',
                    ...viewportTrackScales,
                    scale: '=step ? "linear" : "sqrt"',
                    color: '=color'
                })
            ]
        }
    })
});
