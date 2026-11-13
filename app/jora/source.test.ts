import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createScript } from '../prepare/preprocessing/scripts.js';
import type { CpuProCallFrame } from '../prepare/types.js';
import { methods } from './source.js';

test.each([
    { source: 'abc', offset: 2, position: { line: 0, column: 2 } },
    { source: 'a\nbc', offset: 3, position: { line: 1, column: 1 } },
    { source: 'a\r\nbc', offset: 4, position: { line: 1, column: 1 } },
    { source: 'a\u2028bc', offset: 3, position: { line: 1, column: 1 } },
    { source: 'a\u2029bc', offset: 3, position: { line: 1, column: 1 } },
    { source: 'a\n', offset: 2, position: { line: 1, column: 0 } },
    { source: 'abc', offset: 10, position: { line: 0, column: 3 } }
])('takes the line and column of an offset of $source as V8 counts lines', row => {
    assert.deepEqual(methods.offsetToLineColumn(row.offset, row.source), row.position);
});

test('takes the line and column of an offset of a call frame in its script, no further than its end', () => {
    const script = createScript(1, 'fixture.js', 'x;function f(){return 1}\nf();');
    const callFrame = {
        script,
        start: 12,
        end: 24,
        line: 0,
        column: 12
    } as CpuProCallFrame;

    assert.deepEqual(methods.offsetToLineColumn(20, callFrame), { line: 0, column: 20 });
    assert.deepEqual(methods.offsetToLineColumn(27, callFrame), { line: 0, column: 24 });
    assert.deepEqual(methods.offsetToLineColumn(20, script.source!, callFrame), { line: 0, column: 20 });
});
