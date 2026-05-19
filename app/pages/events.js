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
                { name: 'UpdateLayoutTree', color: '#6bf78c38' }
            ],
            checkbox: {
                checked: '=name in ["MajorGC", "MinorGC"]',
                content: 'text:name'
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
                        text: name + (name = 'EventDispatch' ? ' / ' + data.type : '')
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
                x: $intervals,
                xxx: events.[name in $intervals],
                zzz: events.(name),
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
                maxX: '=maxX'
            }
        ]
    }
});
