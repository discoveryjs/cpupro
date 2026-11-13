// Offsets of the starts of the lines of a document; \n, \r, \r\n, \u2028 and \u2029 end a line, as V8 counts lines
export function computeLineStarts(document: string) {
    // the number of lines is known once the document is searched; the first line starts at 0
    const lineStarts = [0];
    // PERF: Line ends are found by indexOf() rather than a regular expression. The next of each line terminator
    // is kept until a line start passes it, so a document is searched for each of them once; a search of \u2028
    // or \u2029 in a one-byte string ends at once
    let nextLineFeed = nextIndexOf(document, '\n', 0);
    let nextCarriageReturn = nextIndexOf(document, '\r', 0);
    let nextLineSeparator = nextIndexOf(document, '\u2028', 0);
    let nextParagraphSeparator = nextIndexOf(document, '\u2029', 0);

    while (true) {
        const lineEnd = Math.min(nextLineFeed, nextCarriageReturn, nextLineSeparator, nextParagraphSeparator);

        if (lineEnd === document.length) {
            break;
        }

        // \r\n ends a line as a whole
        const lineStart = lineEnd === nextCarriageReturn && document.charCodeAt(lineEnd + 1) === 10 /* \n */
            ? lineEnd + 2
            : lineEnd + 1;

        lineStarts.push(lineStart);

        if (nextLineFeed < lineStart) {
            nextLineFeed = nextIndexOf(document, '\n', lineStart);
        }

        if (nextCarriageReturn < lineStart) {
            nextCarriageReturn = nextIndexOf(document, '\r', lineStart);
        }

        if (nextLineSeparator < lineStart) {
            nextLineSeparator = nextIndexOf(document, '\u2028', lineStart);
        }

        if (nextParagraphSeparator < lineStart) {
            nextParagraphSeparator = nextIndexOf(document, '\u2029', lineStart);
        }
    }

    return new Uint32Array(lineStarts);
}

// The position of the next character from an offset, the end of the document when there's none,
// as a line without a line break ends there
function nextIndexOf(document: string, char: string, offset: number) {
    const index = document.indexOf(char, offset);

    return index !== -1
        ? index
        : document.length;
}

/**
 * Factory function for creating a line boundaries utility over the line starts of a document.
 * Optimized for sequential access patterns (adjacent ranges).
 */
export function createLineBoundaries(
    document: string,
    lineStarts: Uint32Array = computeLineStarts(document)
) {
    let lastLineIndex = 0; // Cache for last looked up line index

    /**
     * Binary search for line index in the given range.
     */
    function binarySearchLineIndex(left: number, right: number, offset: number): number {
        while (left < right) {
            const mid = (left + right + 1) >> 1;
            if (lineStarts[mid] <= offset) {
                left = mid;
            } else {
                right = mid - 1;
            }
        }
        return left;
    }

    /**
     * Get the line index for a given offset in the document.
     * If lines parameter is provided:
     *   - Positive value: move forward N lines
     *   - Negative value: move backward N lines
     * Returns the index of the line containing the offset.
     */
    function getLineIndex(offset: number, lines = 0): number {
        if (offset < 0) {
            return 0;
        }
        if (offset >= document.length) {
            offset = document.length - 1;
        }

        let lineIndex: number;

        // Fast track: check if offset is within or before the cached line range
        if (offset >= lineStarts[lastLineIndex]) {
            // Offset is at or after the start of the last cached line
            if (offset < lineStarts[lastLineIndex + 1]) {
                // Offset is on the same line as last lookup - cache hit!
                lineIndex = lastLineIndex;
            } else {
                // Slow track: offset is beyond the cached line or on the last line
                // Binary search in [lastLineIndex...lineStarts.length - 1]
                lineIndex = binarySearchLineIndex(lastLineIndex, lineStarts.length - 1, offset);
            }
        } else {
            // Offset is before last line - binary search in [0...lastLineIndex]
            lineIndex = binarySearchLineIndex(0, lastLineIndex, offset);
        }

        // Store the line index before applying lines offset
        lastLineIndex = lineIndex;

        // Apply lines offset
        if (lines !== 0) {
            const targetLineIndex = lineIndex + lines;

            if (targetLineIndex < 0) {
                lineIndex = 0;
            } else if (lines > 0) {
                lineIndex = Math.min(targetLineIndex, lineStarts.length - 1);
            } else {
                lineIndex = targetLineIndex;
            }
        }

        return lineIndex;
    }

    //
    // Public API
    //

    function getLine(offset: number, lines = 0): number {
        return getLineIndex(offset, lines) + 1;
    }

    function getColumn(offset: number, lines = 0): number {
        if (offset < 0) {
            return 1;
        }
        if (offset >= document.length) {
            offset = document.length;
        }

        const lineStart = getLineStart(offset, lines);
        return offset - lineStart + 1;
    }

    function getOffset(line: number, column = 1): number {
        if (line < 1) {
            line = 1;
        }

        const lineIndex = line - 1;

        // Clamp to available lines
        const actualLineIndex = Math.min(lineIndex, lineStarts.length - 1);
        const lineStart = lineStarts[actualLineIndex];

        if (column <= 1) {
            return lineStart;
        }

        // Calculate the target offset
        const offset = lineStart + column - 1;

        // If next line exists, clamp to its start (which is current line's end)
        // Otherwise, clamp to document length
        return actualLineIndex + 1 < lineStarts.length
            ? Math.min(offset, lineStarts[actualLineIndex + 1])
            : Math.min(offset, document.length);
    }

    function getLineStart(offset: number, lines = 0): number {
        const lineIndex = getLineIndex(offset, lines);
        return lineStarts[lineIndex];
    }

    function getLineEnd(offset: number, lines = 0): number {
        const lineIndex = getLineIndex(offset, lines);

        // The line end is the start of the next line, or document.length
        return lineIndex + 1 < lineStarts.length
            ? lineStarts[lineIndex + 1]
            : document.length;
    }

    function getLineContentEnd(offset: number, lines = 0): number {
        const lineIndex = getLineIndex(offset, lines);
        let lineEnd = getLineEnd(offset, lines);

        // Exclude line terminators (\n, \r, \r\n, \u2028 or \u2029)
        const lineStart = lineStarts[lineIndex];

        if (lineEnd > lineStart && (document[lineEnd - 1] === '\u2028' || document[lineEnd - 1] === '\u2029')) {
            lineEnd--;
        }

        if (lineEnd > lineStart && document[lineEnd - 1] === '\n') {
            lineEnd--;
        }

        if (lineEnd > lineStart && document[lineEnd - 1] === '\r') {
            lineEnd--;
        }

        return lineEnd;
    }

    function isLineStart(offset: number): boolean {
        return offset === getLineStart(offset);
    }

    function isLineEnd(offset: number): boolean {
        // An offset is at a line end if:
        // - It's at the end of the document (including empty document where offset 0 === document.length)
        // - It's at the start of a line (which is the end of the previous line), but not offset 0
        return offset === document.length || (offset !== 0 && offset === getLineStart(offset));
    }

    function isLineContentEnd(offset: number): boolean {
        return offset === getLineContentEnd(offset);
    }

    function getNewlineText(offset: number, lines = 0): string {
        const lineContentEnd = getLineContentEnd(offset, lines);
        const lineEnd = getLineEnd(offset, lines);

        return document.slice(lineContentEnd, lineEnd);
    }

    function getLineText(offset: number, lines = 0): string {
        const lineStart = getLineStart(offset, lines);
        const lineEnd = getLineEnd(offset, lines);

        return document.slice(lineStart, lineEnd);
    }

    function getLineContentText(offset: number, lines = 0): string {
        const lineStart = getLineStart(offset, lines);
        const lineContentEnd = getLineContentEnd(offset, lines);

        return document.slice(lineStart, lineContentEnd);
    }

    function getLastLine(): number {
        return lineStarts.length;
    }

    function getLinesNumber(): number {
        return getLastLine();
    }

    function getMaxLineEnd(fromLine?: number, toLine?: number): number {
        const lastLine = getLastLine();
        const from = fromLine === undefined
            ? 1
            : Math.max(1, fromLine);
        const to = toLine === undefined
            ? lastLine
            : Math.min(lastLine, toLine);

        if (from > to) {
            return 0;
        }

        return getOffset(to, Infinity);
    }

    function getMaxLineContentEnd(fromLine?: number, toLine?: number): number {
        const lastLine = getLastLine();
        const from = fromLine === undefined
            ? 1
            : Math.max(1, fromLine);
        const to = toLine === undefined
            ? lastLine
            : Math.min(lastLine, toLine);

        if (from > to) {
            return 0;
        }

        const lineStart = getOffset(to, 1);
        return getLineContentEnd(lineStart);
    }

    function getLineDiff(offset1: number, offset2: number): number {
        return getLine(offset2) - getLine(offset1);
    }

    function isSameLine(offset1: number, offset2: number): boolean {
        return getLineDiff(offset1, offset2) === 0;
    }

    return {
        getLine,
        getColumn,
        getOffset,
        getLineStart,
        getLineEnd,
        getLineContentEnd,
        getNewlineText,
        getLineText,
        getLineContentText,
        getLastLine,
        getLinesNumber,
        getMaxLineEnd,
        getMaxLineContentEnd,
        getLineDiff,
        isSameLine,
        isLineStart,
        isLineEnd,
        isLineContentEnd
    };
}
