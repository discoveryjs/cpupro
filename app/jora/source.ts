import type { CpuProCallFrame } from '../prepare/types.js';

export const methods = {
    hasSource: `
        $sourceDefined: => is string and size() > 0;
        callFrame
            | $ or @
            | is object and marker('call-frame').object
            ? regexp is string or (script.source is $sourceDefined and (end - start) > 0)
            : (script
                | $ or @
                | is object and marker('script').object
                | source is $sourceDefined)
    `,

    offsetToLineColumn(offset: number, source: string | CpuProCallFrame, callFrame?: CpuProCallFrame) {
        let lastIndex = 0;
        let line = 0;
        let column = 0;

        if (source && typeof source !== 'string' && !callFrame &&
            typeof source.script?.source === 'string' &&
            Number.isFinite(source.start) &&
            Number.isFinite(source.line) &&
            Number.isFinite(source.end)) {
            callFrame = source;
            source = source.script.source;
        }

        if (typeof source !== 'string') {
            return null;
        }

        if (offset < 0) {
            offset = 0;
        } else if (offset > source.length) {
            offset = source.length;
        }

        if (callFrame && Number.isFinite(callFrame.start) && callFrame.start >= 0) {
            lastIndex = callFrame.start;
            line = callFrame.line;
            column = callFrame.column;

            if (callFrame.end >= callFrame.start && offset > callFrame.end) {
                offset = callFrame.end;
            }
        }

        const nlRx = /\r\n?|\n/g;
        nlRx.lastIndex = lastIndex;
        while (nlRx.exec(source) !== null) {
            if (nlRx.lastIndex > offset) {
                column += offset - lastIndex;
                break;
            }

            lastIndex = nlRx.lastIndex;
            line++;
            column = 0;
        }

        return { line, column };
    },

    sourceFragment: `
        $source: @ or '';
        $limitStart: $$.limitStart or $$.limit or 50;
        $limitEnd: $$.limitEnd or $$.limit or 50;
        $hasSource: $source.bool();
        $sourceOffset: $$.scriptOffset or $$.offset | $hasSource and $ > 0 ? $ : 0;
        $lineStart: $source.lastIndexOf('\\n', $sourceOffset - 1) + 1;
        $lineEnd: $source.indexOf('\\n', $sourceOffset) | $ != -1 ? $source[$ - 1] != '\\r' ?: $ - 1 : $source.size();
        $line: $source[$lineStart:$lineEnd];
        $lineRelStart: $line.match(/^\\s*/).matched[].size();
        $lineRelEnd: $lineEnd - $lineStart;
        $lineRelOffset: $sourceOffset - $lineStart;
        $lineSliceStart: [$lineRelStart, $lineRelOffset - $limitStart - ($lineRelEnd - $lineRelOffset | $ >= $limitEnd ? 0 : $limitEnd - $)].max();
        $lineSliceEnd: [$lineRelEnd, $lineRelOffset + $limitEnd + ($lineRelOffset - $lineSliceStart | $ >= $limitStart ? 0 : $limitStart - $)].min();
        $sliceStart: $lineSliceStart + $lineStart;
        $sliceEnd: $lineSliceEnd + $lineStart;
        $lineNum: $source[0:$sourceOffset].match(/\\r\\n?|\\n/g).size() + 1;

        { $hasSource, $source, $sourceOffset, $lineNum, $lineStart, $lineEnd, $sliceStart, $sliceEnd, slice: $hasSource
            ? [
                $sliceStart != $lineStart + $lineRelStart ? '…' : '',
                $source[$sliceStart:$sliceEnd],
                $sliceEnd != $lineEnd ? '…' : ''
              ].join('')
            : '(source is unavailable)'
        }
    `
};
