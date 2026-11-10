import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createScriptFixture } from '../../../test/fixtures/scripts.js';
import { createVectorLocations } from './locations.js';

test('maps allocations at locations added by resolving other locations to nodes of these locations', () => {
    const source = 'function outer() {\n  return [1].map(function inner(x) { return { x }; });\n}\nouter();';
    const { dictionary, scripts, script } = createScriptFixture(source);
    const { wellKnownIndex } = dictionary.callFrames;

    // the profile's tree resolves unknown and root locations first
    dictionary.resolveLocationIndex(dictionary.callFrames[wellKnownIndex.unknown]);
    dictionary.resolveLocationIndex(dictionary.callFrames[wellKnownIndex.root]);

    // the call frame of a location inside "outer" adds locations of "outer", including its start;
    // another location inside "outer" is added after them, then an allocation hits the start of "outer"
    const scriptOffsets = [source.indexOf('return'), source.indexOf('[1]'), source.indexOf('()')];
    const result = createVectorLocations(
        dictionary,
        scripts,
        scriptOffsets.map(() => 7),
        scriptOffsets,
        null,
        null,
        null
    )!;
    const nodeLocations = result.generatedNodes.parentScriptOffsets;

    assert.deepEqual(
        [...result.samples].map(nodeIndex => nodeLocations[nodeIndex]),
        scriptOffsets.map(offset => dictionary.resolveLocationIndex(null, script, offset))
    );
});

test('maps allocations of a script id given as a string the same way as of a numeric one', () => {
    const nodePaths = (scriptIds: Array<number | string>) => {
        const { dictionary, scripts } = createScriptFixture('function f() { return {}; }');
        const { generatedNodes, samples } = createVectorLocations(
            dictionary,
            scripts,
            scriptIds,
            [-1, -1, 9],
            [1, 0, 2],
            { 1: 'gc', 2: 'parser' },
            null
        )!;
        const { nodeParentId, parentScriptOffsets: nodeLocations } = generatedNodes;
        const paths: (string | number)[][] = [];

        // a context of an allocation in a script is a child node of the script location; node 0 is the root
        for (let i = 0; i < samples.length; i++) {
            const path: (string | number)[] = [];

            for (let j = samples[i]; j !== 0; j = nodeParentId[j]) {
                const location = dictionary.locations[nodeLocations[j]];

                path.push(location.callFrame.name, location.scriptOffset);
            }

            paths.push(path);
        }

        return paths;
    };

    assert.deepEqual(nodePaths(['0', '0', '7']), nodePaths([0, 0, 7]));
});
