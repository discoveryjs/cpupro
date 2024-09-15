discovery.view.define('subject-with-nested-timeline', {
    view: 'context',
    data: `
        $subject;
        $tree;
        $subtree: $tree.subtreeSamples($subject);
        $getCategory: $subject.marker('category') ? =>$ : =>category;
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
            color: $subject.$getCategory().name.color(),
            nested: (
                $selector: $subtree.sampleSelector;
                $subtree.entries.($getCategory()).sort(id asc).({
                    $category: $;
                    $category,
                    color: name.color(),
                    $binTime,
                    bins: #.data.categoriesTree.binCalls(=>($=$category and $selector($$)), $binCount),
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
                // const t = Date.now();

                if (state.timeStart !== null) {
                    context.data.samplesTimingsFiltered.setRange(state.timeStart, state.timeEnd);
                } else {
                    context.data.samplesTimingsFiltered.resetRange();
                }

                // console.log('compute timings', Date.now() - t);
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
                    className: 'category-timings-list',
                    data: 'nested',
                    itemConfig: {
                        className: '=bins[#.segmentStart:#.segmentEnd + 1].sum() = 0 ? "no-time"',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: [
                            'block{ className: "category-name", content: "text:category.name" }',
                            'duration{ data: { time: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalTimeBins[#.segmentStart:#.segmentEnd + 1].sum() } }'
                        ]
                    }
                }
            ]
        },
        {
            view: 'list',
            className: 'function-states',
            limit: false,
            data: `
                $type: subject.marker().type;
                $type = "module" ? (#.data.scripts[=> module = @.subject] | is object ?|
                    $module; compilation.states.({ $module, state: $, color: tier.color(true) })) :
                $type = "function" ? (#.data.scriptFunctions[=> function = @.subject] |
                    $function; states.({ $function, state: $, color: tier.color(true) })) :
                undefined
            `,
            whenData: true,
            itemConfig: {
                view: 'block',
                className: 'tick',
                postRender(el, _, data, ctx) {
                    const state = data.state;
                    const timestamps = data.function
                        ? ctx.data.functionsTreeTimestamps.entriesMap.get(data.function)
                        : ctx.data.modulesTreeTimestamps.entriesMap.get(data.module);
                    const totalTime = ctx.data.totalTime;
                    const step = totalTime / 500;
                    const duration = state.duration ||
                        (timestamps.lastSeen > state.tm && Math.ceil(timestamps.lastSeen / step) * step - state.tm) ||
                        (totalTime - state.tm);

                    el.style.setProperty('--pos', state.tm / totalTime);
                    el.style.setProperty('--duration', duration / totalTime);
                    el.style.setProperty('--tier-color', 'rgb(' + data.color + ', .68)');
                }
            }
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
                color: '=color',
                height: 20
            }
        }
    ]
});
