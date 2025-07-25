import { regexpSourceView, unavailableSourceView } from './common.js';

discovery.view.define('call-frame-source', {
    view: 'switch',
    content: [
        { when: 'regexp', content: regexpSourceView },
        { when: 'hasSource()', content: {
            view: 'source',
            className: 'cpupro-source',
            data: `{
                $script;
                $source: $script.source;
                $sourceSliceStart: $source.lastIndexOf('\\n', start) + 1;
                $sourceSliceEnd: $source.indexOf('\\n', end) | $ != -1 ?: $source.size();
                $sourceSlice: $source[$sourceSliceStart:$sourceSliceEnd].replace(/\\n$/, '');
                $line: line or 1;
                $start;
                $end;
                $unit: #.currentProfile.type = 'memory' ? 'Kb' : 'ms';
                $callFrameCodes: #.currentProfile.codesByCallFrame[=> callFrame = @];
                $values: #.currentProfile
                    | #.nonFilteredTimings
                        ? callFramePositionsTimings or callFramesTimings
                        : callFramePositionsTimingsFiltered or callFramesTimingsFiltered;

                $nestedScriptCodes: #.currentProfile
                    | codesByScript[=> script = $script].callFrameCodes or $script.callFrames.({
                        callFrame: $,
                        codes: []
                    })
                    | .[callFrame | $ != @ and start >= $start and end <= $end];

                $codePoints: $callFrameCodes.codes
                    | .[tier="Ignition"][-1] or .[positions][-1]
                    | positions.match(/O\\d+/g).(+matched[0][1:]) + $start;
                $codePointMarks: $codePoints
                    |? .($ - $sourceSliceStart | is number ? { offset: $ });

                $inlinedPoints: $callFrameCodes.codes.inlinedMatrix();
                $inlinedMarks: $inlinedPoints
                    |? .({
                        offset: offset - $sourceSliceStart,
                        prefix: 'Inline',
                        content: { view: 'text', text: min != max ? min + '…' + max : min},
                        className: 'def',
                        entry: $,
                        tooltip: 'call-frame-inlined-matrix:{ ...entry, mergeSnapshots: entry.snapshots.size() > 10 }'
                    });

                $deoptTooltip: {
                    className: 'view-call-frame-source__deopt_tooltip',
                    content: {
                        view: 'list',
                        data: 'deopts',
                        itemConfig: 'deopt-card'
                    }
                };
                $deoptMarks: $callFrameCodes.codes
                    .(deopt and {
                        $callFrame;
                        $deopt;
                        $inlined: inlined.parseInlined(fns);
                        $path: $deopt.inliningId
                            | $ != -1 ? $ + ..(is number ? $inlined[$].parent) : []
                            | reverse().($inlined[$] | { callFrame, offset })
                            | inlinedPath($callFrame, $deopt.scriptOffset)
                            | $last: $[-1]; .({ ..., marks: $ = $last
                                ? [{ offset, className: 'error', content: 'text:"deopt"' }]
                                : [{ offset, className: 'def', content: 'text:"inline"' }]
                            });

                        index: $callFrameCodes.codes.indexOf($),
                        offset: $path[].offset,
                        $deopt,
                        $path
                    })
                    .group(=> offset)
                    .({
                        className: 'error',
                        offset: key - $sourceSliceStart,
                        prefix: 'Deopt',
                        content: { view: 'text', data: 'deopts.size()', whenData: '$ > 1' },
                        // content: { view: 'block', className: 'view-call-frame-source__deopt_tooltip', content: $deoptTooltip.content },
                        deopts: value,
                        tooltip: $deoptTooltip
                    });

                $icMarks: $callFrameCodes.codes
                    .(ic and (
                        $callFrame;
                        $ic;
                        $inlined: inlined.parseInlined(fns);

                        $ic.group(=>inliningId + '-' + scriptOffset).(
                            $scriptOffset: value[].scriptOffset;
                            $path: value[].inliningId
                                | $ != -1 ? $ + ..(is number ? $inlined[$].parent) : []
                                | reverse().($inlined[$] | { callFrame, offset })
                                | inlinedPath($callFrame, $scriptOffset)
                                | $last: $[-1]; .({ ..., marks: $ = $last
                                    ? [{ offset, className: 'error', content: 'text:"IC"' }]
                                    : [{ offset, className: 'def', content: 'text:"inline"' }]
                            });

                            value.({
                                entry: $,
                                offset: $path[].offset,
                                $path
                            })
                        )
                    ))
                    .group(=> offset)
                    .({
                        offset: key - $sourceSliceStart,
                        className: 'global-ref',
                        prefix: 'IC',
                        content: { view: 'text', data: 'ic.size()' },
                        ic: value,
                        tooltip: 'table:ic.entry'
                    });

                $sampleMarkContent: {
                    view: 'update-on-timings-change',
                    timings: $values,
                    content: {
                        view: 'text-numeric',
                        data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
                        className: => ?: 'empty-content'
                    }
                };
                $selfValueTooltipView: #.currentProfile | type = 'memory' and _memoryGc and _memoryType
                    ? 'allocation-samples-matrix:#.currentProfile | callFramePositionsTree.allocationsMatrix(samplesTimingsFiltered, @.value.entry)';
                $nestedValueTooltipView: #.currentProfile | type != 'memory'
                    ? {
                        className: 'view-call-frame-source__tooltip',
                        content: {
                            view: 'table',
                            data: \`
                                $tree: #.currentProfile.callFramePositionsTreeTimingsFiltered;
                                $tree
                                    .select("nodes", value.entry).node.nodeIndex
                                    .($tree.select("children", $))
                                    .group(=>node.value.callFrame)
                                    .({
                                        callFrame: key,
                                        selfTime: value.sum(=>selfTime),
                                        nestedTime: value.sum(=>nestedTime),
                                        totalTime: value.sum(=>totalTime)
                                    })
                                    .sort(totalTime desc)
                            \`,
                            cols: [
                                { header: 'Self time', content: 'duration:selfTime' },
                                { header: 'Nested time', content: 'duration:nestedTime' },
                                { header: 'Total time', content: 'duration:totalTime' },
                                { header: 'Kind', content: 'call-frame-kind-badge:callFrame.kind' },
                                { header: 'Call frame', content: 'call-frame-badge' }
                            ]
                        }
                    };
                $sampleMarks: $values.entries
                    | $[].entry.callFrame
                        ? .[entry.callFrame = @]
                        : $[=> entry = @]
                    |? .($pos: entry.scriptOffset | is number and $ != -1 ? $ - $sourceSliceStart : $start - $sourceSliceStart; [
                        selfTime ? {
                            offset: $pos,
                            kind: 'self',
                            content: $sampleMarkContent,
                            value: $values.entries[entryIndex],
                            prop: 'selfTime',
                            postfix: $unit,
                            tooltip: $selfValueTooltipView
                        },
                        nestedTime ? {
                            offset: $pos,
                            kind: 'nested',
                            content: $sampleMarkContent,
                            value: $values.entries[entryIndex],
                            prop: 'nestedTime',
                            postfix: $unit,
                            tooltip: $nestedValueTooltipView
                        },
                    ]).[];

                // $allocationMarks: #.currentProfile | type = 'memory'
                //     ? callFramePositionsTimings.entries.[entry | callFrame=@ and scriptOffset > 0]
                //         .({
                //             offset: entry.scriptOffset - $sourceSliceStart,
                //             kind: 'self',
                //             content: $sampleMarkContent,
                //             value: $values.entries[entryIndex],
                //             prop: 'selfTime',
                //             postfix: 'Kb'
                //         });

                $allMarks: {
                    $codePointMarks,
                    // codePointMarksText: $codePoints
                    //     |? .($ - $sourceSliceStart | is number ? { offset: $, abs: $ + $sourceSliceStart, kind: 'none', content: 'text:"O: " + abs' }),
                    $deoptMarks,
                    $icMarks,
                    $inlinedMarks,
                    $sampleMarks,
                    $nestedScriptCodes.({
                        className: 'function-tag',
                        offset: callFrame.start - $sourceSliceStart,
                        content: 'text:tiers',
                        tiers: codes
                            |? size() = 1
                                ? tier[].abbr()
                                : size() <= 3
                                    ? tier.(abbr()).join(' ')
                                    : tier[].abbr() + ' … ' + tier[-1].abbr()
                            : "ƒn"
                    })
                    // $allocationMarks
                };

                $callFrameTooltipView: {
                    className: 'cpupro-hint-tooltip',
                    content: [
                        'badge:callFrameCodes.callFrame.name',
                        'html:"<br>"',
                        {
                            view: 'inline-list',
                            data: 'callFrameCodes.codes',
                            whenData: true,
                            item: [
                                { view: 'text', when: '#.index', text: "\xa0→ " },
                                'code-tier-badge:tier',
                                'text:" " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                            ]
                        }
                ] };

                syntax: "js",
                source: $sourceSlice,
                lineNum: => $ + $line,
                callFrame: @,
                $callFrameCodes,
                $codePoints,
                $inlinedPoints,
                $allMarks,
                marks: $allMarks.values().[].(),
                refs: $nestedScriptCodes.({
                    className: 'function',
                    range: [callFrame.start - $sourceSliceStart, callFrame.end - $sourceSliceStart],
                    marker: callFrame.marker('call-frame').href,
                    callFrameCodes: $,
                    tooltip: $callFrameTooltipView
                })
            }`,
            postRender(el) {
                const contentEl = el.querySelector('.view-source__content');

                contentEl.addEventListener('click', (event) => {
                    const pseudoLinkEl = event.target.closest('.view-source .spotlight.function[data-marker]');

                    if (pseudoLinkEl && contentEl.contains(pseudoLinkEl)) {
                        discovery.setPageHash(pseudoLinkEl.dataset.marker);
                    }
                }, true);
            },
            prelude: {
                view: 'block',
                content: [
                    {
                        view: 'inline-list',
                        className: 'function-path',
                        data: `
                            callFrame 
                            | $start; $end; $target: $; .script.callFrames
                                .[start <= $start and end >= $end]
                                .sort(start asc)
                                .({ $target, callFrame: $ })
                        `,
                        whenData: true,
                        item: { view: 'switch', content: [
                            { when: 'callFrame = target', content: 'block{ className: "target", content: `text:callFrame | function or $ | name or "(anonymous function)"` }' },
                            { when: 'callFrame.marker("call-frame")', content: 'auto-link:callFrame' },
                            { content: 'text:callFrame | name or "(anonymous function)"' }
                        ] }
                    },
                    {
                        view: 'badge',
                        className: 'missed-data-badge',
                        when: '$callFrame; #.currentProfile.codesByCallFrame[=> callFrame = $callFrame].codes.[no positions]',
                        text: 'Some attributes might have inaccurate locations',
                        tooltip: {
                            className: 'cpupro-hint-tooltip',
                            content: {
                                view: 'md',
                                source: [
                                    'Some attributes might have inaccurate locations because certain call frame codes in the V8 log lack position tables. This results in some markers and timings being placed in the function header instead of their actual locations.',
                                    '',
                                    'Due to a known issue, the V8 logger does not include position tables for Sparkplug and Maglev codes at the moment.',
                                    '',
                                    'If all the call frame codes have no position tables, make sure `--log-source-position` is enabled when capturing the V8 log (it\'s enabled by default in Node.js).'
                                ]
                            }
                        }
                    }
                ]
            }
        } },
        { content: unavailableSourceView }
    ]
});
