const { resolveScopeProfileLine } = require('../jora/profile.ts');

discovery.view.define('subject-with-nested-timeline', {
    view: 'context',
    data: `
        $line: scopeLine();
        $profile: $line.profile;
        $subject;
        $tree;
        $subtree: $tree.subtreeSamples($subject);
        $getCategory: $subject.marker('category') ? =>$ : =>category;
        $totalValue: $line.axisTotal;
        $binCount: 500;
        $binSize: $totalValue / $binCount;
        $binSamples: $binCount.countSamples();
        $totalValueBins: $subtree.mask.binCallsFromMask($binCount);

        {
            $profile,
            $line,
            $subject,
            $subtree,
            bins: $tree.binCalls($subject, $binCount),
            $binCount,
            $binSize,
            $binSamples,
            $totalValue,
            $totalValueBins,
            color: $subject.$getCategory().name.color(),
            nested: (
                $selector: $subtree.sampleSelector;
                $subtree.entries.($getCategory()).sort(id asc).({
                    $category: $;
                    $category,
                    color: name.color(),
                    $binSize,
                    bins: $profile.categoriesTree.binCalls(=>($=$category and $selector($$)), $binCount),
                    $totalValueBins
                })
            )
        }
    `,
    content: [
        {
            view: 'time-ruler',
            labels: 'top',
            duration: '=totalValue',
            segments: '=binCount',
            selectionStart: '=line.samplesMetricsFiltered.rangeStart',
            selectionEnd: '=line.samplesMetricsFiltered.rangeEnd',
            onChange: (state, name, el, data) => {
                // console.log('change', state);
                // const t = Date.now();

                if (state.timeStart !== null) {
                    data.line.samplesMetricsFiltered.setRange(state.timeStart, state.timeEnd);
                } else {
                    data.line.samplesMetricsFiltered.resetRange();
                }

                // console.log('compute timings', Date.now() - t);
            },
            details: [
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'text:`Range: ${#.timeStart.formatMicrosecondsTime(totalValue)} – ${#.timeEnd.formatMicrosecondsTime(totalValue)}`' },
                        { view: 'block', content: 'text:`Samples: ${binSamples[#.segmentStart:#.segmentEnd + 1].sum()}`' },
                        { view: 'block', content: ['text:"Duration: "', 'metric:{ value: #.timeEnd - #.timeStart, total: totalValue }'] }
                    ]
                },
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'metric:{ metricName: "selfValue", value: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalValue }' },
                        { view: 'block', content: 'metric:{ metricName: "nestedValue", value: totalValueBins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalValue }' }
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
                            'metric{ value: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalValueBins[#.segmentStart:#.segmentEnd + 1].sum() }'
                        ]
                    }
                }
            ]
        },
        {
            view: 'list',
            className: 'function-codes',
            limit: false,
            context: '{ ...#, binCount }',
            data: `
                $type: subject.marker().type;
                $profile: scopeProfile();
                $totalValue: $profile.timeline.axisTotal;
                $step: $totalValue / #.binCount;

                $profile
                    | $type = "module"     ? codesByScript[=> script = @.subject.script].compilation.codes :
                      $type = "call-frame" ? codesByCallFrame[=> callFrame = @.subject].codes :
                    | .($code: $; segments or [{ tm, duration }] | .({ ..., $code, segment: $ }))
                    | sort(tm asc)
                    | .({
                        code,
                        segment,
                        color: code.tier.color(true),
                        tm,
                        duration: duration
                            or ($lastSeen: code | module or callFrame | bounds($type).lastSeen;
                                $lastSeen > tm ? $step * ($lastSeen / $step).ceil() - tm)
                            or $totalValue - tm
                    })
            `,
            whenData: true,
            itemConfig: {
                view: 'block',
                className: 'tick',
                tooltip: {
                    className: 'subject-with-nested-timeline__code-segment-tooltip',
                    content: [
                        'code-tier-badge:code.tier',
                        'html:code | `<span style=\"color:${tier.color()[:-2]+`d0`}\">${tier}</span><br>`',
                        'text:`Duration: ${duration.ms()}`',
                        { view: 'block', when: 'code.segments.size() > 1', content: [
                            'text:`Segment ${code.segments.indexOf(segment) + 1} of ${code.segments.size()}`',
                            'html:"<br>"',
                            'text:`All segments duration: ${code.segments.sum(=> duration).ms()}`'
                        ] }
                    ]
                },
                postRender(el, _, data, context) {
                    const { tm, duration, color } = data;
                    const { axisTotal, samplesMetricsFiltered } = resolveScopeProfileLine(null, context);

                    el.style.setProperty('--pos', tm / axisTotal);
                    el.style.setProperty('--duration', duration / axisTotal);
                    el.style.setProperty('--tier-color', 'rgb(' + color + ', .68)');
                    // el.addEventListener('click', () => {
                    //     ctx.currentProfile.samplesTimingsFiltered.setRange(code.tm, code.tm + duration);
                    // });
                }
            }
        },
        {
            view: 'sample-histogram',
            className: 'self-time',
            bins: '=bins',
            presence: '=totalValueBins',
            max: '=binSize',
            binsMax: true,
            color: '=color',
            height: 30
        },
        {
            view: 'sample-histogram',
            className: 'nested-time',
            bins: '=totalValueBins',
            max: '=binSize',
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
                view: 'sample-histogram',
                bins: '=bins',
                max: '=binSize',
                binsMax: true,
                color: '=color',
                height: 20
            }
        }
    ]
});
