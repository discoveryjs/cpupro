discovery.view.define('call-frame-source-point', {
    view: 'source',
    className: '=syntax in ["js", "plain"] ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $source: callFrame.script.source or '';
        $limitStart: limitStart or limit or 50;
        $limitEnd: limitEnd or limit or 50;
        $hasSource: $source.bool();
        $scriptOffset: scriptOffset or offset | $hasSource and $ > 0 ? $ : 0;
        $lineStart: $source.lastIndexOf('\\n', $scriptOffset) + 1;
        $lineEnd: $source.indexOf('\\n', $scriptOffset) | $ != -1 ?: $source.size();
        $line: $source[$lineStart:$lineEnd];
        $lineRelStart: $line.match(/^\\s*/).matched[].size();
        $lineRelEnd: $lineEnd - $lineStart;
        $lineRelOffset: $scriptOffset - $lineStart;
        $lineSliceStart: [$lineRelStart, $lineRelOffset - $limitStart - ($lineRelEnd - $lineRelOffset | $ >= $limitEnd ? 0 : $limitEnd - $)].max();
        $lineSliceEnd: [$lineRelEnd, $lineRelOffset + $limitEnd + ($lineRelOffset - $lineSliceStart | $ >= $limitStart ? 0 : $limitStart - $)].min();
        $sliceStart: $lineSliceStart + $lineStart;
        $sliceEnd: $lineSliceEnd + $lineStart;
        $lineNum: $source[0:$scriptOffset].match(/\\r\\n?|\\n/g).size();

        syntax: $hasSource ? 'plain' or 'js',
        source: $hasSource
            ? [
                $sliceStart != $lineStart + $lineRelStart ? '…' : '',
                $source[$sliceStart:$sliceEnd],
                $sliceEnd != $lineEnd ? '…' : ''
              ].join('')
            : '(source is unavailable)',
        lineNum: () => $ + $lineNum,
        marks: marks
            ? marks.({ ..., offset: offset - $sliceStart })
            : [{ offset: $scriptOffset - $sliceStart }]
    }`
});
