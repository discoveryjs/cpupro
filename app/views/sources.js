const regexpSourceView = {
    view: 'source',
    className: 'regexp',
    data: '{ content: regexp, syntax: "regexp", lineNum: false }'
};

const unavailableSourceView = {
    view: 'source',
    lineNum: false,
    actionCopySource: false,
    source: 'source is unavailable'
};

discovery.view.define('script-source', {
    view: 'switch',
    content: [
        { when: 'hasSource()', content: {
            view: 'source',
            className: 'cpupro-source',
            data: `{
                $callFrames;
                $callFrameCodes: #.currentProfile.codesByScript[=> script = @].callFrameCodes or callFrames.({
                    callFrame: $,
                    codes: []
                });
                $tooltipView: [
                    'text:callFrameCodes.callFrame.name',
                    'html:"<br>"',
                    {
                        view: 'inline-list',
                        data: 'callFrameCodes.codes',
                        whenData: true,
                        item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                    }
                ];

                syntax: "js",
                content: source.replace(/\\n$/, ""),
                $callFrameCodes,
                marks: $callFrameCodes.({
                    className: 'function-tag',
                    offset: callFrame.start,
                    content: 'text:tiers',
                    tiers: codes
                        |? size() = 1
                            ? tier[].abbr()
                            : size() <= 3
                                ? tier.(abbr()).join(' ')
                                : tier[].abbr() + ' … ' + tier[-1].abbr()
                        : "ƒn"
                }),
                refs: $callFrameCodes.({
                    className: 'function',
                    range: [callFrame.start, callFrame.end],
                    href: callFrame.marker('call-frame').href,
                    callFrameCodes: $,
                    tooltip: $tooltipView
                })
            }`,
            postRender(el) {
                const contentEl = el.querySelector('.view-source__content');

                contentEl.addEventListener('click', (event) => {
                    const pseudoLinkEl = event.target.closest('.view-source .spotlight[data-href]');

                    if (pseudoLinkEl && contentEl.contains(pseudoLinkEl)) {
                        discovery.setPageHash(pseudoLinkEl.dataset.href);
                    }
                });
            }
        } },
        { content: unavailableSourceView }
    ]
});

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
                // $codePointMarksText: $codePoints
                //     |? .($ - $sourceSliceStart | is number ? { offset: $, abs: $ + $sourceSliceStart, kind: 'none', content: 'text:"O: " + abs' });

                $inlinedMarks: $callFrameCodes.codes[-1].inlined.match(/O\\d+(?=F|$)/g).(+matched[0][1:])
                    |? .({ offset: $ - $sourceSliceStart, content: 'text:"1"', className: 'def', prefix: 'Inline' });

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
                    $codePoints,
                    $codePointMarks,
                    // $codePointMarksText,
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
                data: `
                    callFrame 
                    | $start; $end; $target: $; .script.callFrames
                        .[start <= $start and end >= $end]
                        .sort(start asc)
                        .({ $target, callFrame: $ })
                `,
                content: {
                    view: 'inline-list',
                    className: 'function-path',
                    whenData: true,
                    item: { view: 'switch', content: [
                        { when: 'callFrame = target', content: 'block{ className: "target", content: `text:callFrame | function or $ | name or "(anonymous function)"` }' },
                        { when: 'callFrame.marker("call-frame")', content: 'auto-link:callFrame' },
                        { content: 'text:callFrame | name or "(anonymous function)"' }
                    ] }
                }
            }
        } },
        { content: unavailableSourceView }
    ]
});

discovery.view.define('location-source', {
    view: 'source',
    className: '=syntax = "js" ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $source: callFrame.script.source or '';
        $hasSource: $source.bool();
        $scriptOffset: scriptOffset | $hasSource and $ > 0 ? $ : 0;
        $sourceLineStart: $source.lastIndexOf('\\n', $scriptOffset) + 1;
        $sourceSliceStart: $sourceLineStart + $source.slice($sourceLineStart).match(/^\\s*/).matched[].size();
        $sourceSliceEnd: $source.indexOf('\\n', $scriptOffset) | $ != -1 ?: $source.size();
        $lineNum: $source.slice(0, $scriptOffset).match(/\\r\\n?|\\n/g).size();

        $selfValueTooltipView: #.currentProfile | type = 'memory' and _memoryGc and _memoryType
            ? 'allocation-samples-matrix:#.currentProfile | callFramePositionsTree.allocationsMatrix(samplesTimingsFiltered, @.value.entry)';
        $unit: #.currentProfile.type = 'memory' ? 'Kb' : 'ms';
        $values: #.currentProfile
            | #.nonFilteredTimings
                ? callFramePositionsTimings or callFramesTimings
                : callFramePositionsTimingsFiltered or callFramesTimingsFiltered;
        $sampleMarkContent: {
            view: 'update-on-timings-change',
            timings: $values,
            content: {
                view: 'text-numeric',
                data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
                className: => ?: 'empty-content'
            }
        };
        $sampleMarks:
            #.currentProfile.callFramePositionsTimingsFiltered.getEntry(@)
            .($pos: entry.scriptOffset | $hasSource and is number and $ != -1 ? $ - $sourceSliceStart : 0; [
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
                    postfix: $unit
                },
            ]).[];

        syntax: $hasSource ? 'js',
        lineNum: () => $ + $lineNum,
        source: $hasSource ? $source.slice($sourceSliceStart, $sourceSliceEnd) : '(source is unavailable)',
        marks: $sampleMarks
    }`
});
