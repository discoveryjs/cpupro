/**
 * Factory function for creating a line boundaries utility.
 * Builds line boundary information incrementally as needed for efficient offset lookups.
 * Optimized for sequential access patterns (adjacent ranges).
 */
export function createLineBoundaries(document: string) {
    const newlineRegex = /\r\n|\r|\n/g; // Global regex for scanning
    const lineStarts: number[] = [0]; // Line starts cache (always includes 0)
    let lastLineStart = 0;
    let lastLineIndex = 0; // Cache for last looked up line index
    let fullyScanned = false; // Whether we've scanned the entire document

    /**
     * Ensure we have scanned enough lines.
     * If lineCount is provided, ensures we have at least that many lines cached.
     * If targetOffset is provided, scans until we've covered that offset.
     */
    function ensureLines(lineCount: number, targetOffset?: number): void {
        // Scan until we have enough lines or covered the offset or reach end of document
        while (!fullyScanned) {
            if (lineCount <= lineStarts.length &&
                (targetOffset === undefined || lastLineStart > targetOffset)) {
                break;
            }

            newlineRegex.lastIndex = lastLineStart;
            const match = newlineRegex.exec(document);

            if (match) {
                lastLineStart = newlineRegex.lastIndex;
                lineStarts.push(lastLineStart);
            } else {
                fullyScanned = true;
            }
        }
    }

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
                // Slow track: offset is beyond cached range or on last line
                // Scan until we cover this offset
                ensureLines(lastLineIndex + 2, offset);

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
                ensureLines(targetLineIndex + 1);
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

        // Ensure we have scanned the requested line and the next one to know where current line ends
        ensureLines(lineIndex + 2);

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

        // Ensure we have the next line to get the end
        ensureLines(lineIndex + 2);

        // The line end is the start of the next line, or document.length
        return lineIndex + 1 < lineStarts.length
            ? lineStarts[lineIndex + 1]
            : document.length;
    }

    function getLineContentEnd(offset: number, lines = 0): number {
        const lineIndex = getLineIndex(offset, lines);
        let lineEnd = getLineEnd(offset, lines);

        // Exclude newline characters (\n, \r, or \r\n)
        const lineStart = lineStarts[lineIndex];

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
        // Ensure we've scanned the entire document
        ensureLines(Infinity);
        return lineStarts.length;
    }

    function getLinesNumber(): number {
        return getLastLine();
    }

    function getMaxLineEnd(fromLine?: number, toLine?: number): number {
        const lastLine = getLastLine();
        const from = fromLine === undefined ? 1 : Math.max(1, fromLine);
        const to = toLine === undefined ? lastLine : Math.min(lastLine, toLine);

        if (from > to) {
            return 0;
        }

        return getOffset(to, Infinity);
    }

    function getMaxLineContentEnd(fromLine?: number, toLine?: number): number {
        const lastLine = getLastLine();
        const from = fromLine === undefined ? 1 : Math.max(1, fromLine);
        const to = toLine === undefined ? lastLine : Math.min(lastLine, toLine);

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
