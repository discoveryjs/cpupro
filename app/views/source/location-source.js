discovery.view.define('location-source', {
    view: 'source',
    className: '=syntax = "js" ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $scopeBreakdown: scopeBreakdown();
        $line: $scopeBreakdown.line;
        $locations: $scopeBreakdown | locations or callFrames;
        $locationValues: #.nonFilteredTimings
            ? $locations.all
            : $locations.filtered;
        $source: callFrame.script.source or '';
        $hasSource: $source.bool();
        $start;
        $normStart: scriptOffset != -1 ? scriptOffset : callFrame.start;
        $scriptOffset: $normStart | $hasSource and $ > 0 ? $ : 0;
        $sourceLineStart: $source.lastIndexOf('\\n', $scriptOffset) | $ != $scriptOffset ?: $source.lastIndexOf('\\n', $scriptOffset - 1) | $ + 1;
        $sourceSliceStartRaw: $sourceLineStart + $source.slice($sourceLineStart).match(/^\\s*/).matched[].size();
        $sourceSliceEndRaw: $source.indexOf('\\n', $scriptOffset) | $ != -1 ?: $source.size();
        $prelude: 32;
        $postlude: 64;
        $sourceSliceStart: $scriptOffset - $sourceSliceStartRaw | $ < $prelude ? $sourceSliceStartRaw : $scriptOffset - $prelude;
        $sourceSliceEnd: $sourceSliceEndRaw - $scriptOffset | $ < $postlude ? $sourceSliceEndRaw : $scriptOffset + $postlude;
        $lineNum: $source.slice(0, $scriptOffset).match(/\\r\\n?|\\n/g).size();

        $selfValueTooltipView: $line | type = 'memline' and lineAttribute('allocationType') and lineAttribute('allocationLifespan')
            ? 'allocation-samples-matrix:values.allocationsMatrix(metrics, value.entry).sort(total.sum or 0 desc)';
        $misattributedMessage: { view: 'block', when: 'noloc', className: 'misattributed-message', content: 'text:"Misattributed samples due to missed data in the profile (e.g. position table or call site location)"' };
        $selfValueMisattributedTooltipView: {
            className: 'view-call-frame-source__tooltip',
            content: $misattributedMessage
        };
        $nestedValueTooltipView: {
            className: 'view-call-frame-source__tooltip',
            content: [$misattributedMessage, {
                view: 'table',
                data: \`
                    $tree: scopeBreakdown() | locations or callFrames | filtered.nodes;
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
                    { header: "selfValue".metricName(), content: 'metric:selfValue' },
                    { header: "nestedValue".metricName(), content: 'metric:nestedValue' },
                    { header: "totalValue".metricName(), content: 'metric:totalValue' },
                    { header: 'Kind', content: 'call-frame-kind-badge:callFrame.kind' },
                    { header: 'Call frame', content: 'call-frame-badge' }
                ]
            }]
        };
        $unit: 0.valueAndUnit().unit;
        $values: $locationValues;
        $sampleMarkContent: {
            view: 'update-on-line-metrics-changes',
            metrics: $values.dict,
            content: {
                view: 'text-numeric',
                data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
                className: => ?: 'empty-content'
            }
        };
        $sampleMarks: $values.dict
            | getEntry(@) or getEntry(@.callFrame)
            | .(
               $noloc: @.scriptOffset = -1;
               $offset: entry.scriptOffset | ($hasSource and is number ? ($ != -1 ?: callFrame.start | is number and $ != -1 ?: $scriptOffset) - $sourceSliceStart : 0); [
               selfValue ? {
                    $offset,
                    kind: 'self',
                    className: $noloc ? 'noloc',
                    content: $sampleMarkContent,
                    value: $,
                    values: $values.nodes,
                    metrics: $scopeBreakdown.samplesMetricsFiltered,
                    prop: 'selfValue',
                    postfix: $unit,
                    tooltip: $selfValueTooltipView or ($noloc ? $selfValueMisattributedTooltipView)
                },
                nestedValue ? {
                    $offset,
                    kind: 'nested',
                    className: $noloc ? 'noloc',
                    content: $sampleMarkContent,
                    value: $,
                    prop: 'nestedValue',
                    postfix: $unit,
                    tooltip: $nestedValueTooltipView
                },
                no selfValue and no nestedValue ? {
                    $offset,
                    kind: 'dot'
                }
            ]).[];

        syntax: $hasSource ? 'js',
        lineNum: () => $ + $lineNum,
        source: $hasSource ? $source.slice($sourceSliceStart, $sourceSliceEnd) : '(source is unavailable)',
        marks: $sampleMarks
    }`
});
