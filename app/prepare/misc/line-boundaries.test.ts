import assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeLineStarts, createLineBoundaries } from './line-boundaries.js';

test.each([
    {
        title: 'without line breaks',
        document: 'abc',
        starts: [0]
    },
    {
        title: 'empty',
        document: '',
        starts: [0]
    },
    {
        title: 'with \\n',
        document: 'a\nbc\n',
        starts: [0, 2, 5]
    },
    {
        title: 'with \\r\\n as one line break',
        document: 'a\r\nbc\r\n',
        starts: [0, 3, 7]
    },
    {
        title: 'with \\r alone',
        document: 'a\rbc\r',
        starts: [0, 2, 5]
    },
    {
        title: 'with \\n\\r as two line breaks',
        document: 'a\n\rb',
        starts: [0, 2, 3]
    },
    {
        title: 'with \\u2028 and \\u2029, as V8 counts lines',
        document: 'a\u2028b\u2029c',
        starts: [0, 2, 4]
    },
    {
        title: 'with mixed line breaks and empty lines',
        document: '\r\n\n\ra\r\r\nb',
        starts: [0, 2, 3, 4, 6, 8]
    }
])('finds starts of lines of a document $title', row => {
    assert.deepEqual([...computeLineStarts(row.document)], row.starts);
});

// Every offset of a document and the offsets around it go to their line and column and back,
// a position of a line break is its line end
test.each([
    '',
    'abc',
    'ab\r\ncd\ref\ngh',
    'a\n',
    '\n\n',
    'a\u2028b\u2029'
])('finds lines and columns of offsets and offsets of lines and columns in %j', document => {
    const lines = createLineBoundaries(document);
    const starts = computeLineStarts(document);

    for (let offset = -1; offset <= document.length + 1; offset++) {
        const position = Math.max(0, Math.min(offset, document.length));
        let line = 0;

        while (line + 1 < starts.length && starts[line + 1] <= position) {
            line++;
        }

        const column = position - starts[line];

        assert.equal(lines.lineOf(offset), line, `line of ${offset}`);
        assert.equal(lines.columnOf(offset), column, `column of ${offset}`);
        assert.equal(lines.columnOf(offset, line), column, `column of ${offset} on its line`);
        assert.equal(lines.offsetOf(line, column), position, `offset of ${line}:${column}`);
    }
});

test('takes a line outside a document at its first or last line, a column past a line at the next line', () => {
    const lines = createLineBoundaries('ab\ncd');

    assert.equal(lines.offsetOf(-1, 1), 1);
    assert.equal(lines.offsetOf(0, -1), 0);
    assert.equal(lines.offsetOf(0, 10), 3);
    assert.equal(lines.offsetOf(5, 1), 4);
    assert.equal(lines.offsetOf(1, 10), 5);
});
