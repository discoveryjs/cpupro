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

// Profiles of different processes of a dataset have scripts of the same URL and id with different sources,
// e.g. versions of a script or scripts without a URL
test('profiles share a script of a URL only by its source', () => {
    const dictionary = new Dictionary();
    const first = new ProfileScriptsMap(dictionary, [
        { id: 1, url: '', source: 'void 0' },
        { id: 2, url: '', source: '' },
        { id: 3, url: 'worker.js', source: 'version(1)' }
    ]);
    const second = new ProfileScriptsMap(dictionary, [
        { id: 1, url: '', source: '' },
        { id: 2, url: '', source: 'other' },
        { id: 3, url: 'worker.js', source: 'version(2)' },
        { id: 4, url: 'worker.js', source: 'version(1)' }
    ]);

    assert.equal(second.get(1), first.get(2));
    assert.notEqual(second.get(2), first.get(1));
    assert.equal(second.get(2)!.source, 'other');
    assert.equal(second.get(3)!.source, 'version(2)');
    assert.equal(second.get(4), first.get(3));
    assert.equal(dictionary.scripts.length, 5);
});

test('a script without a source takes a script of its URL the profile has not taken', () => {
    const dictionary = new Dictionary();
    const first = new ProfileScriptsMap(dictionary, [
        { id: 1, url: 'app.js', source: 'a()' },
        { id: 2, url: 'app.js', source: 'b()' }
    ]);
    const second = new ProfileScriptsMap(dictionary);

    assert.equal(second.resolveScript(7, 'app.js'), first.get(1));
    assert.equal(second.resolveScript(8, 'app.js'), first.get(2));
    assert.equal(second.resolveScript(9, 'app.js')!.source, null);
    assert.equal(dictionary.scripts.length, 3);
});

// Generated scripts of a profile repeat a URL and a source under their own ids, with call frames of their own
test('scripts of a profile with the same URL and source are distinct scripts, shared by another profile the same way', () => {
    const dictionary = new Dictionary();
    const first = new ProfileScriptsMap(dictionary, [
        { id: 3, url: '', source: 'generated()' },
        { id: 40, url: '', source: 'generated()' }
    ]);
    const second = new ProfileScriptsMap(dictionary, [
        { id: 5, url: '', source: 'generated()' },
        { id: 6, url: '', source: 'generated()' }
    ]);

    assert.notEqual(first.get(3), first.get(40));
    assert.equal(second.get(5), first.get(3));
    assert.equal(second.get(6), first.get(40));
    assert.equal(dictionary.scripts.length, 2);
});
