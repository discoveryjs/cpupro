discovery.view.define('subject-with-nested-timeline', {
    view: 'context',
    data: `
        $subject;
        $tree;
        $subtree: $tree.subtreeSamples($subject);
        $getArea: $subject.marker('area') ? =>$ : =>area;
        $totalTime: #.data.totalTime;
        $binCount: 500;
        $binTime: $totalTime / $binCount;
        $binSamples: $binCount.countSamples();
        $totalTimeBins: $subtree.mask.binCallsFromMask($binCount);

        {
            $subject,
            $subtree,
            bins: $tree.binCalls($subject, $binCount),
            $binCount,
            $binTime,
            $binSamples,
            totalTime: $totalTime,
            $totalTimeBins,
            color: $subject.$getArea().name.color(),
            nested: (
                $selector: $subtree.sampleSelector;
                $subtree.entries.($getArea()).sort(id asc).({
                    $area: $;
                    $area,
                    color: name.color(),
                    $binTime,
                    bins: #.data.areasTree.binCalls(=>($=$area and $selector($$)), $binCount),
                    $totalTimeBins
                })
            )
        }
    `,
    content: [
        {
            view: 'time-ruler',
            labels: 'top',
            duration: '=totalTime',
            segments: '=binCount',
            selectionStart: '=#.data.samplesTimingsFiltered.rangeStart',
            selectionEnd: '=#.data.samplesTimingsFiltered.rangeEnd',
            onChange: (state, name, el, data, context) => {
                // console.log('change', state);
                const t = Date.now();

                if (state.timeStart !== null) {
                    context.data.samplesTimingsFiltered.setRange(state.timeStart, state.timeEnd);
                } else {
                    context.data.samplesTimingsFiltered.resetRange();
                }

                console.log('compute timings', Date.now() - t);
            },
            details: [
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'text:`Range: ${#.timeStart.formatMicrosecondsTime(totalTime)} – ${#.timeEnd.formatMicrosecondsTime(totalTime)}`' },
                        { view: 'block', content: 'text:`Samples: ${binSamples[#.segmentStart:#.segmentEnd + 1].sum()}`' },
                        { view: 'block', content: ['text:"Duration: "', 'duration:{ time: #.timeEnd - #.timeStart, total: totalTime }'] }
                    ]
                },
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: ['text:"Self time: "', 'duration:{ time: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalTime }'] },
                        { view: 'block', content: ['text:"Nested time: "', 'duration:{ time: totalTimeBins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalTime }'] }
                    ]
                },
                {
                    view: 'list',
                    className: 'area-timings-list',
                    data: 'nested',
                    itemConfig: {
                        className: '=bins[#.segmentStart:#.segmentEnd + 1].sum() = 0 ? "no-time"',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: [
                            'block{ className: "area-name", content: "text:area.name" }',
                            'duration{ data: { time: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalTimeBins[#.segmentStart:#.segmentEnd + 1].sum() } }'
                        ]
                    }
                }
            ]
        },
        {
            view: 'timeline-segments-bin',
            className: 'self-time',
            bins: '=bins',
            presence: '=totalTimeBins',
            max: '=binTime',
            binsMax: true,
            color: '=color',
            height: 30
        },
        {
            view: 'timeline-segments-bin',
            className: 'nested-time',
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
