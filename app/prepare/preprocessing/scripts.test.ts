import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { ProfileScriptsMap, scriptOffsetsFromLineColumns } from './scripts.js';
import type { V8CpuProfileNode } from '../types.js';

// A script inline in a document from line 7 and column 226 (1-based), as V8 reports positions of call frames
// and samples in the document
test('sample offsets are positions in the scripts of samples, the first line from the column offset', () => {
    const source = 'run();\nrun();';
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [{
        id: 7,
        url: 'page.html',
        source,
        lineOffset: 6,
        columnOffset: 225
    }]);
    const callFrame = { scriptId: 7, url: 'page.html', functionName: 'run', lineNumber: 6, columnNumber: 225 };
    const nodes: V8CpuProfileNode[] = [
        { id: 1, callFrame },
        { id: 2, callFrame: { ...callFrame, scriptId: 99 } }
    ];
    const lines = [7, 7, 8, 0, 7];
    const columns = [226, 229, 3, 0, 226];

    assert.deepEqual(scriptOffsetsFromLineColumns(nodes, [1, 1, 1, 1, 2], undefined, scripts, lines, columns), [
        0,
        3,
        source.indexOf('\n') + 3,
        -1,
        -1
    ]);
});
