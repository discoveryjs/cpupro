discovery.view.define('location-source', {
    view: 'source',
    className: '=syntax = "js" ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $line: scopeLine();
        $locations: $line | tree.locations and locations
            ? (#.locationsSource | $ = "tree" or is undefined) ? dict.locations : locations
            : dict.locations or locations;
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

        $selfValueTooltipView: scopeLine() | type = 'memline' and valueLifespans and valueTypes
            // ? 'allocation-samples-matrix:#.currentProfile.memline | tree.(locations or callFrames).filtered.nodes.allocationsMatrix(samplesTimingsFiltered, @.value.entry)';
            ? 'allocation-samples-matrix:values.allocationsMatrix(metrics, value.entry).sort(total.sum or 0 desc)';
        $unit: 0.valueAndUnit().unit;
        $locationValues: $line
            | #.nonFilteredTimings
                ? $locations.all
                : $locations.filtered;
        $values: $locationValues or ($line | #.nonFilteredTimings ? dict.locations.all : dict.locations.filtered);
        $sampleMarkContent: {
            view: 'update-on-line-metrics-changes',
            metrics: $values,
            content: {
                view: 'text-numeric',
                data: 'value[prop] / 1000 | $ > 0 ? toFixed(1) : ""',
                className: => ?: 'empty-content'
            }
        };
        $sampleMarks:
            $values.getEntry(@)
            .($pos: entry.scriptOffset | $hasSource and is number and $ != -1 ? $ - $sourceSliceStart : 0; [
                selfValue ? {
                    offset: $pos,
                    kind: 'self',
                    content: $sampleMarkContent,
                    value: $,
                    values: $locations.sampleToLocation
                        ? $locations.filtered
                        : $line.tree.locations.filtered.nodes,
                    metrics: $locations.sampleToLocation
                        ? { ...$line.samplesMetricsFiltered, samples: $locations.sampleToLocation }
                        : $line.samplesMetricsFiltered,
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
