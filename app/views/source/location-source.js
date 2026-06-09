discovery.view.define('location-source', {
    view: 'source',
    className: '=syntax = "js" ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $tree: scopeTree();
        $line: $tree.line;
        $locations: $tree | locations or callFrames;
        $locationValues: #.nonFilteredTimings
            ? $locations.all
            : $locations.filtered;
        $source: callFrame.script.source or '';
        $hasSource: $source.bool();
        $scriptOffset: scriptOffset | $hasSource and $ > 0 ? $ : 0;
        $sourceLineStart: $source.lastIndexOf('\\n', $scriptOffset) | $ != $scriptOffset ?: $source.lastIndexOf('\\n', $scriptOffset - 1) | $ + 1;
        $sourceSliceStartRaw: $sourceLineStart + $source.slice($sourceLineStart).match(/^\\s*/).matched[].size();
        $sourceSliceEndRaw: $source.indexOf('\\n', $scriptOffset) | $ != -1 ?: $source.size();
        $prelude: 32;
        $postlude: 64;
        $sourceSliceStart: $scriptOffset - $sourceSliceStartRaw | $ < $prelude ? $sourceSliceStartRaw : $scriptOffset - $prelude;
        $sourceSliceEnd: $sourceSliceEndRaw - $scriptOffset | $ < $postlude ? $sourceSliceEndRaw : $scriptOffset + $postlude;
        $lineNum: $source.slice(0, $scriptOffset).match(/\\r\\n?|\\n/g).size();

        $selfValueTooltipView: $line | type = 'memline' and valueLifespans and valueTypes
            ? 'allocation-samples-matrix:values.allocationsMatrix(metrics, value.entry).sort(total.sum or 0 desc)';
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
            | .($pos: entry.scriptOffset | $hasSource and is number and $ != -1 ? $ - $sourceSliceStart : 0; [
                selfValue ? {
                    offset: $pos,
                    kind: 'self',
                    content: $sampleMarkContent,
                    value: $,
                    values: $values.nodes,
                    metrics: $line.samplesMetricsFiltered,
                    prop: 'selfValue',
                    postfix: $unit,
                    tooltip: $selfValueTooltipView
                },
                nestedValue ? {
                    offset: $pos,
                    kind: 'nested',
                    content: $sampleMarkContent,
                    value: $,
                    prop: 'nestedValue',
                    postfix: $unit
                },
                no selfValue and no nestedValue ? {
                    offset: $pos,
                    kind: 'dot'
                }
            ]).[];

        syntax: $hasSource ? 'js',
        lineNum: () => $ + $lineNum,
        source: $hasSource ? $source.slice($sourceSliceStart, $sourceSliceEnd) : '(source is unavailable)',
        marks: $sampleMarks
    }`
});
