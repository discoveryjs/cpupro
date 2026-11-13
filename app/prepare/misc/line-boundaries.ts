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

        if (lineEnd > document.length) {
            break;
        }

        // \r\n ends a line as a whole, when the next \n follows the \r
        const lineStart = lineEnd === nextCarriageReturn && nextLineFeed === lineEnd + 1
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

// The position of the next character from an offset, past the end of the document when there's none,
// so the nearest of several characters is the least of their positions and a missing one is next to none
function nextIndexOf(document: string, char: string, offset: number) {
    const index = document.indexOf(char, offset);

    return index !== -1
        ? index
        : document.length + 1;
}

// Lines and columns of a document over its line starts; lines and columns are 0-based, as positions of V8 are.
// An offset outside the document is taken at its start or its end, a line outside it at its first or last line,
// and a column past the end of its line at the start of the next line.
// PERF: The methods are on the prototype, so an instance holds its fields only, as there is one per script
class LineBoundaries {
    length: number;
    lineStarts: Uint32Array;

    constructor(length: number, lineStarts: Uint32Array) {
        this.length = length;
        this.lineStarts = lineStarts;
    }

    // The line of an offset: the last line starting at or before it
    lineOf(offset: number) {
        const lineStarts = this.lineStarts;
        let left = 0;
        let right = lineStarts.length - 1;

        offset = Math.min(offset, this.length);

        while (left < right) {
            const middle = (left + right + 1) >>> 1;

            if (lineStarts[middle] <= offset) {
                left = middle;
            } else {
                right = middle - 1;
            }
        }

        return left;
    }

    // The column of an offset on its line, the line is given when it's known
    columnOf(offset: number, line = this.lineOf(offset)) {
        return Math.max(0, Math.min(offset, this.length)) - this.lineStarts[line];
    }

    offsetOf(line: number, column: number) {
        const lineStarts = this.lineStarts;
        const lastLine = lineStarts.length - 1;

        line = Math.max(0, Math.min(line, lastLine));

        const lineEnd = line < lastLine
            ? lineStarts[line + 1]
            : this.length;

        return Math.min(lineStarts[line] + Math.max(0, column), lineEnd);
    }
}

export function createLineBoundaries(
    document: string,
    lineStarts: Uint32Array = computeLineStarts(document)
) {
    return new LineBoundaries(document.length, lineStarts);
}
