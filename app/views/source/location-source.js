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
