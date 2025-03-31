export default function({ textView }) {
    textView.define('call-frame-source', {
        view: 'source',
        context: '{ ..., currentProfile: #.data.currentProfile }',
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

            $sampleMarkContent: {
                view: 'text',
                data: 'value[prop] | $ > 0 ? (@.prop = "selfTime" ? "self: " : "nested: ") + unit() : ""'
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
                        prop: 'selfTime'
                    },
                    nestedTime ? {
                        offset: $pos,
                        kind: 'nested',
                        content: $sampleMarkContent,
                        value: $values.entries[entryIndex],
                        prop: 'nestedTime'
                    },
                ]).[];

            $allMarks: {
                $sampleMarks
            };

            syntax: "js",
            source: $sourceSlice,
            lineNum: => $ + $line,
            callFrame: @,
            $allMarks,
            marks: $allMarks.values().[].()
        }`
    });
}
