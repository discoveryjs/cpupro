import { regexpSourceView, unavailableSourceView } from './common.js';

const sourceQuery = `{
    $tree: scopeTree();
    $line: $tree.line;
    $locations: $tree | locations or callFrames;
    $locationValues: #.nonFilteredTimings
        ? $locations.all
        : $locations.filtered;
    $script;
    $source: $script.source;
    $sourceSliceLineStart: $source.lastIndexOf('\\n', start) + 1;
    $sourceSliceFnPrefix: $source[$sourceSliceLineStart:start].match(/(?:(?:async|get|set)\\s+)?(?:function(?:\\s+[a-z_$][a-z0-9_$]*)?|[a-z_$][a-z0-9_$]*)?\\s*$/i).start | is number ? $sourceSliceLineStart + $ : @.start;
    $sourceSliceLineEnd: $source.indexOf('\\n', end) | $ != -1 ?: $source.size();
    $sourceSliceStart: $sourceSliceLineStart | @.start - $ < 40 ?: $sourceSliceFnPrefix;
    $sourceSliceEnd: $sourceSliceLineEnd | $sourceSliceStart = $sourceSliceLineStart ?: @.end;
    $sourceSlice: $source[$sourceSliceStart:$sourceSliceEnd].replace(/\\n$/, '');
    $lineNum: line or 1;
    $start;
    $end;
    $unit: 0.valueAndUnit().unit;
    $callFrameCodes: #.currentProfile.codesByCallFrame[=> callFrame = @];
    $values: $locationValues;// or ($tree | #.nonFilteredTimings ? callFrames.all.dict : callFrames.filtered.dict);

    $formatting: #.sourceFormatting = 'beautified' ? $sourceSlice.jsBeautifyRanges().(
        content
            ? { offset: range[0], kind: 'none', className: 'formatting', text: content, content: 'text:text' }
            : { range, className: 'remove-formatting' }
    ) : [];

    $nestedScriptCodes: #.currentProfile
        | codesByScript[=> script = $script].callFrameCodes or $script.callFrames.({
            callFrame: $,
            codes: []
        })
        | .[callFrame | $ != @ and start >= $start and end <= $end];

    $codePoints: $callFrameCodes.codes
        | .[tier="Ignition"][-1] or .[tier="Sparkplug" and positions][-1]
        | positions.match(/O\\d+/g).(+matched[0][1:]);
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
    $deoptMarks: $callFrameCodes.codes or [] |
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

    $icMarks: $callFrameCodes.codes or [] |
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
        view: 'update-on-line-metrics-changes',
        metrics: $values.nodes,
        content: {
            view: 'text-numeric',
            data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
            className: => ?: 'empty-content'
        }
    };
    $selfValueTooltipView: $line | type = 'memline' and valueLifespans and valueTypes
        ? 'allocation-samples-matrix:values.allocationsMatrix(metrics, value.entry).sort(total.sum or 0 desc)';
    $misattributedMessage: { view: 'block', when: 'noloc', className: 'misattributed-message', content: 'text:"Misattributed samples due to missed data in the profile (e.g. position table or call site location)"' };
    $selfValueMisattributedTooltipView: {
        className: 'view-call-frame-source__tooltip',
        content: $misattributedMessage
    };
    $nestedValueTooltipView: $line | type != 'memline'
        ? {
            className: 'view-call-frame-source__tooltip',
            content: [$misattributedMessage, {
                view: 'table',
                data: \`
                    $tree: scopeTree() | locations or callFrames | filtered.nodes;
                    $tree
                        .select("nodes", value.entry).node.nodeIndex
                        .($tree.select("children", $))
                        .group(=>node.value | callFrame or $)
                        .({
                            callFrame: key,
                            selfValue: value.sum(=>selfValue),
                            nestedValue: value.sum(=>nestedValue),
                            totalValue: value.sum(=>totalValue)
                        })
                        .sort(totalValue desc)
                \`,
                cols: [
                    { header: 'Self time', content: 'metric:selfValue' },
                    { header: 'Nested time', content: 'metric:nestedValue' },
                    { header: 'Total time', content: 'metric:totalValue' },
                    { header: 'Kind', content: 'call-frame-kind-badge:callFrame.kind' },
                    { header: 'Call frame', content: 'call-frame-badge' }
                ]
            }]
        };
    $sampleMarks: $values.dict.entries
        | $[].entry.callFrame
            ? .[entry | script = $script and (callFrame = @ or (scriptOffset >= $start and scriptOffset <= $end))]
            : $[=> entry = @]
        |? .($noloc: entry.scriptOffset = -1; $offset: entry.scriptOffset | (is number and $ != -1 ?: $start) - $sourceSliceStart; [
            selfValue ? {
                $offset,
                $noloc,
                kind: 'self',
                className: $noloc ? 'noloc',
                content: $sampleMarkContent,
                value: $values.dict.entries[entryIndex],
                values: $values.nodes,
                metrics: $line.samplesMetricsFiltered,
                prop: 'selfValue',
                postfix: $unit,
                tooltip: $selfValueTooltipView or ($noloc ? $selfValueMisattributedTooltipView)
            },
            nestedValue ? {
                $offset,
                $noloc,
                kind: 'nested',
                className: $noloc ? 'noloc',
                content: $sampleMarkContent,
                value: $values.dict.entries[entryIndex],
                prop: 'nestedValue',
                postfix: $unit,
                tooltip: $nestedValueTooltipView
            },
            [{ t: $ }]
        ]).[];

    // $allocationMarks: #.currentProfile | type = 'memory'
    //     ? callFramePositionsTimings.entries.[entry | callFrame=@ and scriptOffset > 0]
    //         .({
    //             offset: entry.scriptOffset - $sourceSliceStart,
    //             kind: 'self',
    //             content: $sampleMarkContent,
    //             value: $values.dict.entries[entryIndex],
    //             prop: 'selfValue',
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
    lineNum: => $ + $lineNum,
    callFrame: @,
    $callFrameCodes,
    $codePoints,
    $inlinedPoints,
    $allMarks,
    marks: $formatting.[no range] +
        $allMarks.values().().sort(offset asc, (noloc or false) desc),
    refs: $formatting.[range] +
        $nestedScriptCodes.({
            className: 'function',
            range: [callFrame.start - $sourceSliceStart, callFrame.end - $sourceSliceStart],
            marker: callFrame.marker('call-frame').href,
            callFrameCodes: $,
            tooltip: $callFrameTooltipView
        }),
}`;

discovery.view.define('call-frame-source', {
    view: 'switch',
    content: [
        { when: 'regexp', content: regexpSourceView },
        { when: 'hasSource()', content: {
            view: 'context',
            modifiers: [
                {
                    view: 'block',
                    className: 'view-call-frame-source__settings',
                    content: [
                        {
                            view: 'toggle-group',
                            name: 'sourceFormatting',
                            value: '="getSessionSetting".callAction("call-frame-source__formatting", "original")',
                            data: [
                                {
                                    value: 'original',
                                    text: 'Original'
                                },
                                {
                                    value: 'beautified',
                                    text: 'Beautified'
                                }
                            ]
                        }
                    ]
                }
            ],
            content: {
                view: 'source',
                className: 'cpupro-source',
                data: sourceQuery,
                postRender(el, config, data, context) {
                    context.actions.setSessionSetting?.('call-frame-source__formatting', context.sourceFormatting);
                    if (context.locationsSource) {
                        context.actions.setSessionSetting?.('call-frame-source__line-locations', context.locationsSource);
                    }

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
            }
        } },
        { content: unavailableSourceView }
    ]
});
