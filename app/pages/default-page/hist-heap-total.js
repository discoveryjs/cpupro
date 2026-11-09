import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';
import { withScopeValue, scopeValueContent, scopeBinsContext } from './scope-values.js';

// Heap sizes are binned for the line window, histograms follow it. Totals are of the line viewport: the range
// of heap sizes (peaks of bins of the same size as the window bins) and the sums of allocated and released sizes
export const histHeapTotal = withScopeValue('heapScope', '=scopeLine().viewport', `
    scopeProfile().heap | events ? {
        $totalHeapSize: events.binHeapTotal(#.binCount, capacity);

        minTotal: $totalHeapSize.min(),
        maxTotal: $totalHeapSize.max(),
        newTotal: events.binHeapEvents("new", #.binCount).sum(),
        deleteTotal: events.binHeapEvents("delete", #.binCount).sum()
    }
`, withLineWindowValue('heapBins', `
    scopeProfile().heap | events ? {
        $new: events.binHeapEvents("new", #.binCount);
        $delete: events.binHeapEvents("delete", #.binCount);

        totalHeapSize: events.binHeapTotal(#.binCount, capacity),
        $new,
        $delete
    }
`, {
    view: 'expand',
    when: '#.primaryLineType != "memline"',
    ...sessionExpandState('default-timelines-heap', false, '$'),
    data: `
        $profile: scopeProfile();
        $profile.heap | events ? {
            available,
            extent: $profile.timeline.timestampExtent(events[-1].tm, 0)
        }
    `,
    className: '=no $ ? "unavailable"',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Heap size"'
        },
        histHeapTotalHeader()
    ],
    rulerDetails: {
        view: 'block',
        className: 'details-section',
        whenData: true,
        content: [
            {
                view: 'block',
                className: 'details-section-title',
                content: 'text:"Heap size"'
            },
            {
                view: 'list',
                className: 'category-timings-list with-from',
                data: `$scope: #.heapScope.value; #.heapBins.value | [
                    { $selection: totalHeapSize[#.binStart:#.binEnd]; name: 'Total size', value: $selection.max(), from: $selection.min(), total: $scope.maxTotal },
                    { name: 'Allocated', value: new[#.binStart:#.binEnd].sum(), total: $scope.newTotal },
                    { name: 'Released', value: delete[#.binStart:#.binEnd].sum(), total: $scope.deleteTotal }
                ]`,
                itemConfig: {
                    className: '=value = 0 ? "no-value"',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                    content: [
                        'block{ content: "text:name" }',
                        {
                            view: 'block',
                            className: 'value-with-from',
                            content: [
                                { view: 'text-numeric', when: 'from is number', text: '=`${from.bytes(false)} … `' },
                                'value-fraction{ value: value.bytes(false), fraction: value / total  }'
                            ]
                        }
                    ]
                }
            }
        ]
    },
    content: {
        view: 'switch',
        content: [
            { when: '$', content: histHeapTotalBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain the necessary data. Use [V8 log](https://v8.dev/docs/profile) (raw) to enable the feature."'
            } }
        ]
    }
}), scopeBinsContext);

// Totals of the line viewport shown with the data of the section, rendered again when they change
function withHeapScope(content) {
    return scopeValueContent('heapScope', {
        view: 'context',
        data: '{ ..., ...#.heapScope.value }',
        content
    });
}

function histHeapTotalHeader() {
    return {
        view: 'switch',
        content: [
            { when: 'no $', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
            { content: [
                withHeapScope({ view: 'block', className: 'labeled-value-groups', content: [
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '#5b88c6',
                            text: 'Total size',
                            value: [
                                'text-numeric:minTotal.bytes()',
                                {
                                    view: 'context',
                                    when: 'minTotal != maxTotal',
                                    content: [
                                        'text:" … "',
                                        'text-numeric:maxTotal.bytes()'
                                    ]
                                }
                            ]
                        },
                        {
                            view: 'labeled-value',
                            when: 'available',
                            text: 'Limit',
                            value: 'text-numeric:available.bytes(false, 1024)'
                        }
                    ] },
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '#bf8354',
                            text: 'Allocated',
                            value: 'text-numeric:newTotal.bytes()'
                        },
                        {
                            view: 'labeled-value',
                            color: '#80a556',
                            text: 'Released',
                            value: 'text-numeric:deleteTotal.bytes()'
                        }
                    ] }
                ] })
            ] }
        ]
    };
}

function histHeapTotalBody() {
    return [
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el) => el.style.setProperty('--color', '#5b88c6'),
                    content: 'text:"Total size"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: withHeapScope([
                        'text-with-unit{ value: maxTotal.bytes(false), unit: true }',
                        'text-with-unit{ value: minTotal.bytes(), unit: true }'
                    ])
                },
                lineWindowHistogram('heapBins', '{ ..., ...#.heapBins.value }', {
                    className: 'mem-bins',
                    height: 36,
                    extent: '=extent',
                    bins: '=totalHeapSize',
                    peaks: true,
                    // max: '=max() | $ < 20_000_000 ?: 20_000_000',
                    binsMax: true,
                    color: '#5b88c6'
                })
            ]
        },
        {
            color: '#bf8354',
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    content: 'text:"Allocations"',
                    postRender: (el) => el.style.setProperty('--color', '#bf8354')
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: withHeapScope('text-with-unit{ value: newTotal.bytes(false), unit: true }')
                },
                lineWindowHistogram('heapBins', '{ ..., ...#.heapBins.value }', {
                    className: 'mem-bins',
                    extent: '=extent',
                    bins: '=new',
                    scaleBins: '=[new, delete]',
                    binsMax: true,
                    color: '#bf8354'
                })
            ]
        },
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    content: 'text:"Releases"',
                    postRender: (el) => el.style.setProperty('--color', '#80a556')
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: withHeapScope('text-with-unit{ value: deleteTotal.bytes(false), unit: true }')
                },
                lineWindowHistogram('heapBins', '{ ..., ...#.heapBins.value }', {
                    className: 'mem-bins heap-delete-chunks',
                    extent: '=extent',
                    bins: '=delete',
                    scaleBins: '=[new, delete]',
                    binsMax: true,
                    color: '#80a556'
                })
            ]
        }
    ];
}
