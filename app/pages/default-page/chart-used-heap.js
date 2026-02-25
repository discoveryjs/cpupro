import { sessionExpandState } from '../common.js';

export const chartUsedHeap = {
    view: 'expand',
    ...sessionExpandState('default-chart-used-heap', false, '$'),
    data: `scopeProfile() | {
        minX: timeline.axisStart + timeline.axisStartNoSamples,
        maxX: timeline.axisEnd,
        points: thread.events.[name="UpdateCounters" or name="MinorGC" or name="MajorGC"].(
            name="UpdateCounters" ? { x: tm, y: data.jsHeapSizeUsed or data.usedHeapSizeAfter, event: $ }
            : [{ x: tm, y: data.usedHeapSizeBefore, event: $ }, { x: tm + duration, y: data.usedHeapSizeAfter, event: $ }]
        )
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
                    {
                        view: 'block',
                        className: 'labeled-value-groups persistent',
                        data: '{ min: points.y.min(), max: points.y.max(), ...points.updownSum(=>y) }',
                        content: [
                            { view: 'block', className: 'labeled-value-group', content: { view: 'labeled-value-list', data: `[
                                { label: 'Range', value: \`\${min.bytes()} – \${max.bytes()}\` },
                                { label: 'Range size', value: \`\${(max - min).bytes()}\` }
                            ]`, label: 'text:label', value: 'text:value' } },
                            { view: 'block', className: 'labeled-value-group', content: { view: 'labeled-value-list', data: `[
                                { label: 'Allocated', value: up.bytes() },
                                { label: 'Garbage Collected', value: down.bytes() },
                                { label: 'Net Change', value: (up - down).bytes() }
                            ]`, label: 'text:label', value: 'text:value' } }
                        ]
                    }
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
};

function chartUsedHeapBody() {
    return [
        {
            view: 'cpupro-chart',
            minX: '=minX',
            maxX: '=maxX',
            points: '=points',
            labelFormat: '==>bytes()',
            height: 120,
            color: '#e8bc6da0'
        }
    ];
}
