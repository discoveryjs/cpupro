const { resolveScopeProfileLine } = require('../jora/profile.ts');
const { withLineWindow, withLineWindowValue, lineWindowHistogram } = require('./misc/line-window.js');

// Bins are computed for a window of the line viewport, the views showing them follow its changes
discovery.view.define('subject-with-nested-timeline', withLineWindow({
    data: `
        $scopeBreakdown: scopeBreakdown();
        $scopeLine: $scopeBreakdown.line;
        $subject;
        $tree;
        $subtree: $tree.subtreeSamples($subject);
        $getCategory: $subject.marker('category') ? =>$ : =>category;

        {
            profile: $scopeLine.profile,
            $scopeLine,
            $scopeBreakdown,
            $subject,
            $tree,
            $subtree,
            totalValue: $scopeLine.axisTotal,
            color: $subject.$getCategory().name.color(),
            nested: $subtree.entries.($getCategory()).sort(id asc).({ category: $, color: name.color() })
        }
    `,
    content: withLineWindowValue('subjectBins', `
        $viewport: scopeViewport();
        $binCount: #.binCount;
        $binSize: ($viewport.end - $viewport.start) / $binCount;
        $totalValueBins: subtree.mask.binCallsFromMask($binCount, scopeBreakdown);
        $metricsSource: scopeLine.primaryBreakdown().categories.all.nodes;
        $selector: subtree.sampleSelector;

        {
            $binSize,
            binSamples: $binCount.countSamples(),
            $totalValueBins,
            bins: tree.binCalls(subject, $binCount),
            nested: nested.({
                $category: category;

                ...,
                $binSize,
                bins: $metricsSource.binCalls(=>$=$category and $selector($$), $binCount),
                $totalValueBins
            })
        }
    `, [
        {
            view: 'line-ruler',
            labels: 'top',
            window: '=#.lineWindow',
            zoom: true,
            rangeManager: '=scopeLine.range.selection',
            details: {
                view: 'context',
                data: '{ ..., ...#.subjectBins.value }',
                content: [
                    {
                        view: 'block',
                        className: 'timeline-segment-info',
                        content: [
                            { view: 'block', content: 'text:`Range: ${#.labelStart.formatValue(#.resolution)} – ${#.labelEnd.formatValue(#.resolution)}`' },
                            { view: 'block', content: 'text:`Samples: ${binSamples[#.segmentStart:#.segmentEnd + 1].sum() or 0}`' },
                            { view: 'block', content: ['text:"Duration: "', 'metric:{ value: #.timeEnd - #.timeStart, total: totalValue, resolution: #.resolution }'] }
                        ]
                    },
                    {
                        view: 'block',
                        className: 'timeline-segment-info',
                        content: [
                            { view: 'block', content: 'metric:{ metricName: "selfValue", value: bins[#.segmentStart:#.segmentEnd + 1].sum() or 0, total: totalValue, resolution: #.resolution }' },
                            { view: 'block', content: 'metric:{ metricName: "nestedValue", value: totalValueBins[#.segmentStart:#.segmentEnd + 1].sum() or 0, total: totalValue, resolution: #.resolution }' }
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
                                'metric{ value: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: totalValueBins[#.segmentStart:#.segmentEnd + 1].sum(), resolution: #.resolution }'
                            ]
                        }
                    }
                ]
            }
        },
        // Ends of code ticks are rounded to bins of the window
        {
            view: 'update-on-line-metrics-changes',
            metrics: '=#.lineWindow',
            content: {
                view: 'context',
                context: '#.lineWindow.value',
                content: {
                    view: 'line-intervals',
                    className: 'function-codes',
                    when: 'scopeLine.type = "timeline"',
                    zoom: true,
                    data: `
                    $totalValue: profile.timeline.axisTotal;
                    $axisStart: scopeLine.axisStart;
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
                            tierColor: code.tier.color(true),
                            tm,
                            duration: duration
                                or ($lastSeen: code | module or callFrame | bounds($type).lastSeen;
                                    $lastSeen > tm ? $step * ($lastSeen / $step).ceil() - tm)
                                or $totalValue - tm
                        })
                        | .({ ..., start: $axisStart + tm, end: $axisStart + tm + duration })
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
                            const { start, end, tierColor } = data;
                            const { range } = resolveScopeProfileLine(null, context);

                            el.style.setProperty('--tier-color', 'rgb(' + tierColor + ', .68)');
                            el.addEventListener('click', () => {
                                range.selection.setRange(start, end);
                            });
                        }
                    }
                }
            }
        },
        {
            view: 'block',
            className: 'self-time',
            content: lineWindowHistogram('subjectBins', '{ ..., ...#.subjectBins.value }', {
                bins: '=bins',
                presence: '=totalValueBins',
                max: '=binSize',
                binsMax: true,
                color: '=color',
                height: 31
            })
        },
        {
            view: 'block',
            className: 'nested-time',
            content: lineWindowHistogram('subjectBins', '{ ..., ...#.subjectBins.value }', {
                bins: '=totalValueBins',
                max: '=binSize',
                binsMax: true,
                color: '=nested.size() > 1 ? color : nested[].color',
                height: 30
            })
        },
        {
            view: 'list',
            className: 'nested-work',
            data: 'nested',
            whenData: 'size() > 1',
            item: lineWindowHistogram('subjectBins', '$category: category; #.subjectBins.value.nested[=> category = $category]', {
                bins: '=bins',
                max: '=binSize',
                binsMax: true,
                color: '=color',
                height: 20
            })
        }
    ])
}));
