import { sessionExpandState } from '../common.js';

export const userTimingsTimeline = {
    view: 'expand',
    ...sessionExpandState('default-user-timings-timeline', false, '$'),
    data: `scopeProfile() | {
        $min: timeline.axisStart + timeline.axisStartNoSamples; // $timingEvents.start.min();

        minX: $min,
        maxX: timeline.axisEnd,
        spans: thread.userTimings
            .({ start: tm, end: tm + duration, text: name, event: $ })
            .[start is number and start >= 0],
        intervals: thread.events.[name="MinorGC" or name="MajorGC"]
            .({ start: tm, end: tm + duration, name, color: name = 'MinorGC' ? '#f7b26b38' : '#f78c6b38' })
            .[start is number]
            + [0, 500000].({ offset: $, name: "Timeline", color: '#6666' })
    }`,
    className: '=`user-timings-timeline ${no spans ? "unavailable" : ""}`',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"User timings"'
        },
        {
            view: 'context',
            when: 'no spans',
            content: 'html:` <span style=\"color: #888\">(unavailable)</span>`'
        }
    ],
    content: {
        view: 'switch',
        content: [
            { when: 'spans', content: userTimingsTimelineBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain User Timing API event records. Use tracing with enabled `blink.user_timing` category."'
            } }
        ]
    }
};

function userTimingsTimelineBody() {
    return [
        {
            view: 'track-timeline',
            spans: '=spans',
            intervals: '=intervals',
            minX: '=minX',
            maxX: '=maxX',
            tooltipClassName: 'events-track-timeline-tooltip',
            tooltipContent: [
                'badge:"User Timing"',
                'header:text',
                {
                    view: 'labeled-value-list',
                    kind: 'inline-grid',
                    label: 'text:text',
                    value: {
                        view: 'switch',
                        content: [
                            { when: 'text="Duration"', content: 'metric' },
                            { content: 'text:value.formatMicrosecondsTimeFixed()' }
                        ]
                    },
                    data: `[
                        { text: 'Duration', value: end - start },
                        { text: 'Start', value: #.spanStart },
                        { text: 'End', value: #.spanEnd }
                    ]`
                },
                'struct{ data: event.data, whenData: true, expanded: 2 }'
            ]
        }
    ];
}
