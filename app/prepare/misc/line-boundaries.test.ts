import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLineBoundaries } from './line-boundaries.js';

// Line starts of a document, read by the offsets of its lines; a line past the last one has the last line's offset
function lineStarts(document: string) {
    const lines = createLineBoundaries(document);
    const starts = [lines.getOffset(1)];

    for (let line = 2; lines.getOffset(line) !== starts[starts.length - 1]; line++) {
        starts.push(lines.getOffset(line));
    }

    return starts;
}

test.each([
    { title: 'without line breaks', document: 'abc', starts: [0] },
    { title: 'empty', document: '', starts: [0] },
    { title: 'with \\n', document: 'a\nbc\n', starts: [0, 2, 5] },
    { title: 'with \\r\\n as one line break', document: 'a\r\nbc\r\n', starts: [0, 3, 7] },
    { title: 'with \\r alone', document: 'a\rbc\r', starts: [0, 2, 5] },
    { title: 'with \\n\\r as two line breaks', document: 'a\n\rb', starts: [0, 2, 3] },
    { title: 'with mixed line breaks and empty lines', document: '\r\n\n\ra\r\r\nb', starts: [0, 2, 3, 4, 6, 8] }
])('finds starts of lines of a document $title', row => {
    assert.deepEqual(lineStarts(row.document), row.starts);
});

test('finds lines of offsets in any order of lookups', () => {
    const document = 'ab\r\ncd\ref\ngh';
    const lines = createLineBoundaries(document);

    assert.deepEqual([11, 0, 7, 4, 3].map(offset => lines.getLine(offset)), [4, 1, 3, 2, 1]);
});
