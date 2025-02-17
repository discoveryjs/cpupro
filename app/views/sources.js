const regexpSourceView = {
    view: 'source',
    className: 'regexp',
    data: '{ content: regexp, syntax: "regexp", lineNum: false }'
};

const unavailableSourceView = {
    view: 'source',
    lineNum: false,
    source: 'source is unavailable'
};

discovery.view.define('script-source', {
    view: 'switch',
    content: [
        { when: 'regexp', content: regexpSourceView },
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
                    'text:scriptFunction.callFrame.name',
                    'html:"<br>"',
                    {
                        view: 'inline-list',
                        data: 'scriptFunction.codes',
                        item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                    }
                ];

                syntax: "js",
                content: source.replace(/\\n$/, ""),
                $callFrameCodes,
                refs__: $callFrameCodes.({
                    $href: callFrame.marker('call-frame').href;
                    $marker: codes | size() = 1
                        ? tier[].abbr()
                        : size() <= 3
                            ? tier.(abbr()).join(' ')
                            : tier[].abbr() + ' … ' + tier[-1].abbr();

                    className: 'function',
                    range: [callFrame.start, callFrame.end],
                    marker: $href ? $marker + '" data-href="' + $href : $marker,
                    scriptFunction: $,
                    tooltip: $tooltipView
                }),
                marks: $callFrameCodes.({
                    className: 'function-tag',
                    offset: callFrame.start,
                    content: 'text:tiers',
                    tiers: codes | size() = 1
                        ? tier[].abbr()
                        : size() <= 3
                            ? tier.(abbr()).join(' ')
                            : tier[].abbr() + ' … ' + tier[-1].abbr()
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
        { countent: unavailableSourceView }
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
                $scriptFunction: #.currentProfile.codesByCallFrame[=> callFrame = @];
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

                $inlinePoints: $scriptFunction.codes
                    | $[-1]
                    | inlined.match(/O\\d+(?=F|$)/g).matched;
                $codePoints: $scriptFunction.codes
                    | $.[tier="Ignition"][-1] or .[positions][-1]
                    | positions.match(/O\\d+(?=C|$)/g).matched;

                $inlinedMarks: $scriptFunction.codes[-1].inlined.match(/O\\d+(?=F|$)/g).matched
                    |? .({ offset: +$[1:] - $sourceSliceStart, content: 'text:"1"', className: 'def', prefix: 'Inline' });
                $codePointMarks: $codePoints
                    |? .(+$[1:] - $sourceSliceStart | is number ? { offset: $ });
                $codePointMarksText: $codePoints
                    |? .($x: +$[1:];+$[1:] - $sourceSliceStart | is number ? { offset: $, abs: $x, kind: 'none', content: 'text:"O: " +abs' });

                $sampleMarkContent: {
                    view: 'update-on-timings-change',
                    timings: $values,
                    content: {
                        view: 'text-numeric',
                        data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
                        className: => ?: 'empty-content'
                    }
                };
                $sampleMarks: $values.entries
                    | $[].entry.callFrame
                        ? .[entry.callFrame = @]
                        : $[=> entry = @]
                    |? .($pos: entry.scriptOffset | is number and $ != -1 ? $ - $sourceSliceStart : $start - $sourceSliceStart; [
                        selfTime   ? { offset: $pos, kind: 'self',   content: $sampleMarkContent, value: $values.entries[entryIndex], prop: 'selfTime', postfix: $unit },
                        nestedTime ? { offset: $pos, kind: 'nested', content: $sampleMarkContent, value: $values.entries[entryIndex], prop: 'nestedTime', postfix: $unit },
                    ]).[];

                $allocationMarks: #.currentProfile | type = 'memory'
                    ? callFramePositionsTimings.entries.[entry | callFrame=@ and scriptOffset > 0]
                        .({
                            offset: entry.scriptOffset - $sourceSliceStart,
                            kind: 'self',
                            content: $sampleMarkContent,
                            value: $values.entries[entryIndex],
                            prop: 'selfTime',
                            postfix: 'Kb'
                        })
                    : [];

                $allMarks: {
                    $codePointMarks,
                    $inlinedMarks,
                    $sampleMarks,
                    $nestedScriptCodes.({
                        className: 'function-tag',
                        offset: callFrame.start - $sourceSliceStart,
                        content: 'text:tiers',
                        tiers: codes | size() = 1
                            ? tier[].abbr()
                            : size() <= 3
                                ? tier.(abbr()).join(' ')
                                : tier[].abbr() + ' … ' + tier[-1].abbr()
                    })
                    // $codePointMarksText,
                    // $allocationMarks
                };

                $tooltipView: {
                    className: 'cpupro-hint-tooltip',
                    content: [
                        'text:callFrameCodes.callFrame.name',
                        'html:"<br>"',
                        {
                            view: 'inline-list',
                            data: 'callFrameCodes.codes',
                            item: 'text:"\xa0→ " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                        }
                ] };

                syntax: "js",
                source: $sourceSlice,
                lineNum: => $ + $line,
                callFrame: @,
                $allMarks,
                marks: $allMarks.values().[].(),
                refs: $nestedScriptCodes.({
                    className: 'function',
                    range: [callFrame.start - $sourceSliceStart, callFrame.end - $sourceSliceStart],
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
