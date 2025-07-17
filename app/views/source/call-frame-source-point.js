discovery.view.define('call-frame-source-point', {
    view: 'source',
    className: '=syntax in ["js", "plain"] ? "cpupro-source" : "cpupro-source unavailable"',
    actionCopySource: false,
    data: `{
        $sourceFragment: callFrame.script.source.sourceFragment({
            offset,
            scriptOffset,
            limit,
            limitStart,
            limitEnd
        });

        syntax: $sourceFragment.hasSource ? 'plain' or 'js',
        source: $sourceFragment.slice,
        lineNum: () => $ + $sourceFragment.lineNum,
        marks: marks
            ? marks.({ ..., offset: offset - $sourceFragment.sliceStart })
            : [{ offset: $sourceFragment.sourceOffset - $sourceFragment.sliceStart }]
    }`
});
