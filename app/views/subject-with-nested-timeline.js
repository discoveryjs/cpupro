discovery.view.define('subject-with-nested-timeline', {
    view: 'context',
    data: `
        $subject;
        $tree;
        $getArea: $subject.marker('area') ? =>$ : =>area;
        $totalTime: #.data.totalTime;
        $binCount: 500;
        $binTime: $totalTime / $binCount;
        $binSamples: $binCount.countSamples();
        $subtree: $tree.subtreeSamples($subject);

        {
            $subject,
            $subtree,
            bins: $tree.binCalls($subject, $binCount),
            $binCount,
            $binTime,
            $binSamples,
            totalTime: $totalTime,
            totalTimeBins: $subtree.mask.binCallsFromMask($binCount),
            color: $subject.$getArea().name.color(),
            nested: (
                $selector: $subtree.sampleSelector;
                $subtree.entries.($getArea()).sort(id asc).({
                    $area: $;
                    $area,
                    color: name.color(),
                    $binTime,
                    bins: #.data.areasTree.binCalls(=>($=$area and $selector($$)), $binCount),
                })
            )
        }
    `,
    content: [
        {
            view: 'time-ruler',
            captions: 'top',
            duration: '=totalTime',
            segments: '=binCount',
            details: [
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'text:`Range: ${#.startTime.formatMicrosecondsTime(totalTime)} – ${#.endTime.formatMicrosecondsTime(totalTime)}`' },
                        { view: 'block', content: 'text:`Samples: ${binSamples[#.startSegment:#.endSegment + 1].sum()}`' },
                        { view: 'block', content: ['text:"Duration: "', 'duration:{ time: #.endTime - #.startTime, total: totalTime }'] }
                    ]
                },
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: ['text:"Self time: "', 'duration:{ time: bins[#.startSegment:#.endSegment + 1].sum(), total: totalTime }'] },
                        { view: 'block', content: ['text:"Nested time: "', 'duration:{ time: totalTimeBins[#.startSegment:#.endSegment + 1].sum(), total: totalTime }'] }
                    ]
                },
                {
                    view: 'list',
                    className: 'area-timings-list',
                    data: 'nested',
                    itemConfig: {
                        className: '=bins[#.startSegment:#.endSegment + 1].sum() = 0 ? "no-time"',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: [
                            'block{ className: "area-name", content: "text:area.name" }',
                            'duration{ data: { time: bins[#.startSegment:#.endSegment + 1].sum(), total: binTime } }'
                        ]
                    }
                }
            ]
        },
        {
            view: 'timeline-segments-bin',
            bins: '=bins',
            presence: '=totalTimeBins',
            max: '=binTime',
            binsMax: true,
            color: '=color',
            height: 30
        },
        {
            view: 'timeline-segments-bin',
            className: 'total-time',
            bins: '=totalTimeBins',
            max: '=binTime',
            binsMax: true,
            color: '=nested.size() > 1 ? color : nested[].color',
            height: 30
        },
        {
            view: 'list',
            className: 'nested-work',
            data: 'nested',
            whenData: 'size() > 1',
            item: {
                view: 'timeline-segments-bin',
                bins: '=bins',
                max: '=binTime',
                binsMax: true,
                color: '=area.name.color()',
                height: 20
            }
        }
    ]
});
