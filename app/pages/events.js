discovery.page.define('events', {
    view: 'context',
    modifiers: [
        {
            view: 'select',
            name: 'pageProcess',
            data: 'defaultSession.processes.sort(name asc)',
            value: '$[=>$=scopeProfile().thread.process]',
            item: 'text:`${value.name or "Process "} (pid:${value.pid})`'
        },
        {
            view: 'checkbox-list',
            name: 'intervals',
            data: [
                { name: 'MinorGC', color: '#f7b26b38' },
                { name: 'MajorGC', color: '#f78c6b38' },
                { name: 'Layout', color: '#6ba0f738' },
                { name: 'UpdateLayoutTree', color: '#6bf78c38' },
                { name: 'Paint', color: '#6bacf738' },
                { name: 'AnimationFrame::StyleAndLayout', text: 'Recalculate Styles', color: '#6bfff738' }
            ],
            checkbox: {
                checked: '=name in ["MajorGC", "MinorGC"]',
                content: 'text:text or name'
            }
        }
    ],
    content: {
        view: 'context',
        data: `
            $threadOrder: ['CrRendererMain', 'DedicatedWorker thread', 'Compositor'].reverse();
            #.pageProcess.threads
                .[events or profiles]
                .sort($threadOrder.indexOf(name) desc, name asc, events.size() desc)
            | {
                $minX: events.[tm>0].tm.min();
                $maxX: events.[tm>0 and duration!=-1].(tm + duration).max();
                $cutMin: => $ - 0;
                $intervals: {...#.intervals.({ key: name, value: color }).fromEntries()};
                $spans: .({
                    $thread: $;
                    name: \`\${name} (pid:\${pid} tid:\${tid})\`,
                    spans: events.[tm > 0 and duration > 0 and name!="Animation"].({
                        start: tm | $cutMin(),
                        end: tm + duration | $cutMin(),
                        text: name + (name = 'EventDispatch' ? ' / ' + data.type : ''),
                        event: $
                    }),
                    intervals: events.[$intervals[name]].({
                        start: tm | $cutMin(),
                        end: tm + duration | $cutMin(),
                        text: name,
                        color: $intervals[name] or "#00000038"
                    }) + (profiles[] | $ ? [
                        // { start: timeline.axisStart - $minX, end: timeline.axisEnd - $minX, color: "red" },
                        // { start: timeline.axisStart + timeline.axisStartNoSamples - $minX, end: timeline.axisEnd - $minX, color: "orange" },
                    ] : [])
                });
                spans: $spans,
                $minX,
                maxX: $maxX | $cutMin()
            }`,
        content: [
            {
                view: 'track-timeline',
                spans: '=spans',
                groups: true,
                unit: 'us',
                intervals: '=intervals',
                minX: '=minX',
                maxX: '=maxX',
                tooltipClassName: 'events-track-timeline-tooltip',
                tooltipContent: [
                    'badge:event.cat',
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
        ]
    }
});
