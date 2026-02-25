discovery.page.define('threads', {
    view: 'context',
    data: `scopeProfile().thread.process.threads.[events or profiles].sort(['CrRendererMain', 'DedicatedWorker thread', 'Compositor'].reverse().indexOf(name) desc, name asc, events.size() desc) | {
        $minX: events.[tm>0].tm.min();
        $maxX: events.[tm>0 and duration!=-1].(tm + duration).max();
        $cutMin: => $ - 0;
        $spans: .({
            $thread: $;
            name: \`\${name} (\${pid}:\${tid})\`,
            spans: events.[tm > 0 and duration > 0 and name!="Animation"].({
                start: tm | $cutMin(),
                end: tm + duration | $cutMin(),
                text: name + (name = 'EventDispatch' ? ' / ' + data.type : '')
            }),
            intervals: events.[name="MinorGC" or name="MajorGC" or name="Layout" or name="UpdateLayoutTree"].({
                start: tm | $cutMin(),
                end: tm + duration | $cutMin(),
                text: name,
                color: name = 'MinorGC' ? '#f7b26b38' : name = 'MajorGC' ? '#f78c6b38' : name = 'Layout' ? '#6ba0f738' : '#6bf78c38'
            }) + (profiles[] | $ ? [
                // { start: timeline.axisStart - $minX, end: timeline.axisEnd - $minX, color: "red" },
                // { start: timeline.axisStart + timeline.axisStartNoSamples - $minX, end: timeline.axisEnd - $minX, color: "orange" },
            ] : []),
            penalty: events.[name="MinorGC" or name="MajorGC" or name="Layout" or name="UpdateLayoutTree"].sum(=>duration),
            penalty2: events.[name="V8.HandleInterrupts"].sum(=>duration)
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
            maxX: '=maxX'
        }
    ]
});
