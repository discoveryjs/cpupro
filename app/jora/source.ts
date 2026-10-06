import type { CpuProCallFrame } from '../prepare/types.js';
import jsBeautify from 'js-beautify/js/src/javascript/index.js';

function performJSBeautify(source: string, options): string {
    return jsBeautify(source, {
        indent_size: 4,
        space_in_empty_paren: true,
        jslint_happy: true,
        end_with_newline: false,
        ...options
    });
}

function unicodeCharCode(conde: number): string {
    return 'U+' + conde.toString(16).toUpperCase().padStart(4, '0');
}

export const methods = {
    sourceUnicodeCharacters(source: string | null) {
        const result: {
            character: string;
            code: string;
            offset: number;
            fragment: string;
            start: number;
            end: number;
        }[] = [];

        if (typeof source !== 'string') {
            return result;
        }

        for (const match of source.matchAll(/[^\x00-\xff]/gu)) {
            const character = match[0];
            const offset = match.index;
            let start = offset;
            let end = offset + character.length;

            for (let count = 0; count < 32 && start > 0; count++) {
                const last = source.charCodeAt(--start);
                const previous = source.charCodeAt(start - 1);

                if (last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
                    start--;
                }
            }

            for (let count = 0; count < 32 && end < source.length; count++) {
                end += source.codePointAt(end)! > 0xffff ? 2 : 1;
            }

            result.push({
                character,
                code: unicodeCharCode(character.codePointAt(0)!),
                offset,
                fragment: source.slice(start, end),
                start: offset - start,
                end: offset - start + character.length
            });
        }

        return result;
    },

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

    jsBeautify: performJSBeautify,
    jsBeautifyRanges(source: string, options) {
        const ranges: { range: [number, number], content: string }[] = [];
        const beautified = performJSBeautify(source, options);

        for (let i = 0, j = 0; i < source.length && j < beautified.length; i++, j++) {
            if (source[i] !== beautified[j]) {
                if (/\s/.test(source[i])) {
                    const start = i;
                    while (i < source.length && source[i] !== beautified[j] && /\s/.test(source[i])) {
                        i++;
                    }
                    ranges.push({
                        range: [start, i],
                        content: ''
                    });
                    i--;
                    j--;
                } else {
                    const start = j;

                    j++;
                    while (j < beautified.length && source[i] !== beautified[j]) {
                        j++;
                    }
                    ranges.push({
                        range: [i, i],
                        content: beautified.slice(start, j)
                    });
                }
            }
        }

        return ranges;
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
        $prefix: $sliceStart != $lineStart + $lineRelStart ? '…' : '';
        $offsetCorrection: $sliceStart - $prefix.size();

        { $hasSource, $source, $sourceOffset, $lineNum, $lineStart, $lineEnd, $sliceStart, $sliceEnd, $offsetCorrection, slice: $hasSource
            ? [
                $prefix,
                $source[$sliceStart:$sliceEnd],
                $sliceEnd != $lineEnd ? '…' : ''
              ].join('')
            : '(source is unavailable)'
        }
    `
};
