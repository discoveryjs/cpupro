import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';
import { viewportShare, viewportShareText, withViewportAttributeTotals } from './scope-values.js';

export const histAllocationTypes = withViewportAttributeTotals('allocationType', {
    view: 'expand',
    data: '"allocationType".allocationAttributeRows().[value].sort(value desc)',
    whenData: true,
    ...sessionExpandState('default-allocation-types', false, '$'),
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Allocation types"'
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
                                limit: false,
                                itemConfig: {
                                    view: 'labeled-value',
                                    color: '=color or entry.colorRand()',
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
    content: withLineWindowValue('attributeBins', '"allocationType".binAllocationAttribute(#.binCount)', {
        view: 'list',
        className: 'category-timelines-list',
        limit: 10,
        item: {
            view: 'link',
            className: 'category-timelines-item',
            data: '{ ..., color: color or entry.colorRand() }',
            content: [
                {
                    view: 'block',
                    className: 'label allocation-type-label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                    content: {
                        view: 'block',
                        className: 'text',
                        content: 'text:entry.replace(/\\(\\d+\\)\\s*/, "")',
                        tooltip: 'text:entry'
                    }
                },
                {
                    view: 'block',
                    className: 'total-percent',
                    content: viewportShareText()
                },
                lineWindowHistogram('attributeBins', '$track: #.attributeBins.value[index]; { ..., bins: $track.bins, max: $track.max, step: $track.step }', {
                    bins: '=bins',
                    max: '=max',
                    scale: '=step ? "linear" : "sqrt"',
                    binsMax: true,
                    color: '=color'
                })
            ]
        }
    })
});
