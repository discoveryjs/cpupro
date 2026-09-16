const { resolveScopeProfileLine, resolveScopeViewport } = require('../jora/profile.ts');

discovery.view.define('subject-with-nested-timeline', {
    view: 'context',
    data: `
        $scopeBreakdown: scopeBreakdown();
        $scopeLine: $scopeBreakdown.line;
        $profile: $scopeLine.profile;
        $subject;
        $tree;
        $subtree: $tree.subtreeSamples($subject);
        $getCategory: $subject.marker('category') ? =>$ : =>category;
        $totalValue: $scopeLine.axisTotal;
        $viewport: scopeViewport();
        $duration: $viewport.end - $viewport.start;
        $binCount: 500.binCount($viewport);
        $binSize: $duration / $binCount;
        $binSamples: $binCount.countSamples();
        $totalValueBins: $subtree.mask.binCallsFromMask($binCount, $scopeBreakdown);

        {
            $profile,
            $scopeLine,
            $scopeBreakdown,
            $subject,
            $subtree,
            bins: $tree.binCalls($subject, $binCount),
            $binCount,
            $binSize,
            $binSamples,
            $totalValue,
            $duration,
            $totalValueBins,
            color: $subject.$getCategory().name.color(),
            nested: (
                $metricsSource: $scopeLine.primaryBreakdown().categories.all.nodes;
                $selector: $subtree.sampleSelector;
                $subtree.entries.($getCategory()).sort(id asc).({
                    $category: $;
                    $category,
                    color: name.color(),
                    $binSize,
                    bins: $metricsSource.binCalls(=>$=$category and $selector($$), $binCount),
                    $totalValueBins
                })
            )
        }
    `,
    content: [
        {
            view: 'time-ruler',
            labels: 'top',
            duration: '=duration',
            segments: '=binCount',
            rangeManager: '=scopeViewport().viewportRange(scopeLine)',
            details: [
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'text:`Range: ${#.timeStart.formatValue()} – ${#.timeEnd.formatValue()}`' },
                        { view: 'block', content: 'text:`Samples: ${binSamples[#.segmentStart:#.segmentEnd + 1].sum() or 0}`' },
                        { view: 'block', content: ['text:"Duration: "', 'metric:{ value: #.timeEnd - #.timeStart, total: totalValue }'] }
                    ]
                },
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    content: [
                        { view: 'block', content: 'metric:{ metricName: "selfValue", value: bins[#.segmentStart:#.segmentEnd + 1].sum() or 0, total: totalValue }' },
                        { view: 'block', content: 'metric:{ metricName: "nestedValue", value: totalValueBins[#.segmentStart:#.segmentEnd + 1].sum() or 0, total: totalValue }' }
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
            when: 'scopeLine.type = "timeline"',
            limit: false,
            context: '{ ...#, binCount }',
            data: `
                $totalValue: profile.timeline.axisTotal;
                $type: subject.marker().type;
                $viewport: scopeViewport();
                $step: ($viewport.end - $viewport.start) / #.binCount;

                profile
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
                    const { axisStart, range } = resolveScopeProfileLine(null, context);
                    const viewport = resolveScopeViewport(null, context);
                    const start = axisStart + tm;
                    const total = viewport.end - viewport.start;

                    el.style.setProperty('--pos', (start - viewport.start) / total);
                    el.style.setProperty('--duration', duration / total);
                    el.style.setProperty('--tier-color', 'rgb(' + color + ', .68)');
                    el.addEventListener('click', () => {
                        range.selection.setRange(start, start + duration);
                    });
                }
            }
        },
        {
            view: 'block',
            className: 'self-time',
            content: {
                view: 'line-histogram',
                bins: '=bins',
                presence: '=totalValueBins',
                max: '=binSize',
                binsMax: true,
                color: '=color',
                height: 31
            }
        },
        {
            view: 'block',
            className: 'nested-time',
            content: {
                view: 'line-histogram',
                bins: '=totalValueBins',
                max: '=binSize',
                binsMax: true,
                color: '=nested.size() > 1 ? color : nested[].color',
                height: 30
            }
        },
        {
            view: 'list',
            className: 'nested-work',
            data: 'nested',
            whenData: 'size() > 1',
            item: {
                view: 'line-histogram',
                bins: '=bins',
                max: '=binSize',
                binsMax: true,
                color: '=color',
                height: 20
            }
        }
    ]
});
