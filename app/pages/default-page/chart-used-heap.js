import { sessionExpandState } from '../common.js';
import { withScopeValue, scopeValueContent } from './scope-values.js';

// Points of the whole profile are drawn and the zoom is displayed within them; the stats and the scale of sizes
// are of the line viewport, with the counters interpolated at its edges
export const chartUsedHeap = withScopeValue('usedHeapScope', '=scopeLine().viewport', `
    $scope: scopeLine().lineViewport(#.data.profiles);
    $counters: scopeProfile().thread.counters;
    $used: $counters[=> name = "used-heap-size"].values.selectCountersWithOuters($scope.start, $scope.end);
    $total: $counters[=> name = "total-heap-size"].values.selectCountersWithOuters($scope.start, $scope.end);
    $used ? {
        min: $used.value.min(),
        max: $used.value.max(),
        maxY: [$used.value.max(), $total.value.max()].max(),
        ...$used.updownSum(=> value)
    }
`, {
    view: 'expand',
    ...sessionExpandState('default-chart-used-heap', false, '$'),
    data: `scopeProfile() | {
        extent: timeline.timestampExtent(),
        points: thread.counters[=>name="used-heap-size"].values
            .({ x: tm, y: value, event }),
        pointsTotal: thread.counters[=>name="total-heap-size"].values
            .({ x: tm, y: value, event })
    }`,
    className: '=no points ? "unavailable"',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Used heap size"'
        },
        {
            view: 'switch',
            content: [
                { when: 'no points', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
                { content: [
                    scopeValueContent('usedHeapScope', {
                        view: 'block',
                        className: 'labeled-value-groups persistent',
                        data: '#.usedHeapScope.value',
                        whenData: true,
                        content: [
                            { view: 'block', className: 'labeled-value-group', content: { view: 'labeled-value-list', data: `[
                                { label: 'Range', value: \`\${min.bytes()} – \${max.bytes()}\` },
                                { label: 'Range size', value: (max - min).bytes() }
                            ]`, label: 'text:label', value: 'text:value' } },
                            { view: 'block', className: 'labeled-value-group', content: { view: 'labeled-value-list', data: `[
                                { label: 'Allocated', value: up.bytes() },
                                { label: 'Garbage Collected', value: down.bytes() },
                                { label: 'Net Change', value: (up - down).bytes() }
                            ]`, label: 'text:label', value: 'text:value' } }
                        ]
                    })
                ] }
            ]
        }
    ],
    content: {
        view: 'switch',
        content: [
            { when: 'points', content: chartUsedHeapBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain `UpdateCounters`, `MinorGC` or `MajorGC` event records. Use tracing with enabled `disabled-by-default-devtools.timeline` and `devtools.timeline,v8` categories."'
            } }
        ]
    }
});

function chartUsedHeapBody() {
    return [
        scopeValueContent('usedHeapScope', {
            view: 'cpupro-chart',
            extent: '=extent',
            minY: '=#.usedHeapScope.value.min',
            maxY: '=#.usedHeapScope.value.maxY',
            minX: '=scopeViewport().start',
            maxX: '=scopeViewport().end',
            zoom: true,
            points: '=points',
            pointsTotal: '=pointsTotal',
            labelFormat: '==>bytes()',
            height: 120,
            color: '#e8bc6da0',
            tooltipClassName: 'events-track-timeline-tooltip',
            tooltipContent: [
                'badge:"Used heap size"',
                'header:y.bytes()',
                {
                    view: 'labeled-value-list',
                    kind: 'inline-grid',
                    label: 'text:text',
                    value: 'text:value',
                    data: `[
                        { text: 'Time', value: #.pointOffset.formatMicrosecondsTimeFixed() },
                        { text: 'Event', value: event.name + (event.duration > 0 ? (x = event.tm ? ' start' : ' end') : '') },
                        #.edgeCrossing and {
                            text: 'Chart edge',
                            value: \`≈\${#.edgeCrossing.value.bytes()} at \${#.edgeCrossing.offset.formatMicrosecondsTimeFixed()}\`
                        }
                    ].[$]`
                }
            ]
        })
    ];
}
