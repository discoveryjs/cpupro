import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createScriptFixture, parseScriptFixture } from '../../../test/fixtures/scripts.js';
import { Dictionary } from '../dictionary.js';
import { ProfileScriptsMap } from './scripts.js';
import { createLocationsFromScriptOffsets, createVectorLocations } from './locations.js';
import type { CpuProLocation } from '../types.js';

// Offsets 15 and 22 are inside "a" of script 7 and inside "c" of script 8, offsets 44 and 51 are inside "b"
function createScripts() {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [
        { id: 7, url: 'first.js', source: 'function a() { return b(); }\nfunction b() { return {}; }' },
        { id: 8, url: 'second.js', source: 'function c() { return []; }' }
    ]);

    parseScriptFixture(scripts.get(7)!);
    parseScriptFixture(scripts.get(8)!);

    return { dictionary, scripts };
}

function describeLocation(location: CpuProLocation) {
    return `${location.callFrame.origName}:${location.scriptOffset}`;
}

// Locations of the node of each allocation and of its ancestors, up to the root (node 0, its own parent)
function allocationPaths(dictionary: Dictionary, result: NonNullable<ReturnType<typeof createVectorLocations>>) {
    const { samples, sourceIdToNode, parent, nodes } = result;
    const paths: string[] = [];

    for (let i = 0; i < samples.length; i++) {
        const path: string[] = [];

        for (let j = sourceIdToNode[samples[i]]; j !== 0; j = parent[j]) {
            path.push(describeLocation(dictionary.locations[nodes[j]]));
        }

        paths.push(path.join(' < '));
    }

    return paths;
}

test.each<{
    title: string;
    scriptIds: number[] | Int32Array;
    scriptOffsets: number[] | Int32Array;
    contextInfo: number[] | Uint32Array | null;
    vmStateNames: Record<number, string> | null;
    builtinsNames: Record<number, string> | null;
    paths: string[];
    nodes: number;
}>([
    {
        title: 'at script offsets to a node per location',
        scriptIds: [7, 7, 7],
        scriptOffsets: [22, 22, 15],
        contextInfo: null,
        vmStateNames: null,
        builtinsNames: null,
        paths: ['a:22', 'a:22', 'a:15'],
        nodes: 4
    },
    {
        title: 'at the same offset of other scripts to locations of these scripts',
        scriptIds: [7, 8, 7],
        scriptOffsets: [22, 22, 22],
        contextInfo: null,
        vmStateNames: null,
        builtinsNames: null,
        paths: ['a:22', 'c:22', 'a:22'],
        nodes: 4
    },
    {
        title: 'without a script and context info to the unknown location',
        scriptIds: [0],
        scriptOffsets: [-1],
        contextInfo: null,
        vmStateNames: null,
        builtinsNames: null,
        paths: ['(unknown):-1'],
        nodes: 2
    },
    {
        title: 'without a script to VM states up to 0x0f and to builtins above it',
        scriptIds: [0, 0, 0, 0, 0],
        scriptOffsets: [-1, -1, -1, -1, -1],
        contextInfo: [1, 1, 2, 0x0f, 0x20],
        vmStateNames: { 1: 'gc', 2: 'parser', 15: 'idle' },
        builtinsNames: { 2: 'ArrayMap' },
        paths: ['(gc):-1', '(gc):-1', '(parser):-1', '(idle):-1', '(builtin) ArrayMap:-1'],
        nodes: 6
    },
    {
        title: 'without a script to unknown VM states and unsigned builtin IDs',
        scriptIds: new Int32Array([0, 0, 0]),
        scriptOffsets: new Int32Array([-1, -1, -1]),
        contextInfo: new Uint32Array([3, 0x50, 0x8000_0000]),
        vmStateNames: null,
        builtinsNames: null,
        paths: [
            '(unknown-vm-state[3]):-1',
            '(builtin) unknown-builtin[5]:-1',
            '(builtin) unknown-builtin[134217728]:-1'
        ],
        nodes: 5
    },
    {
        title: 'at a script offset with context info to a child node of the location',
        scriptIds: [7, 7, 7, 0],
        scriptOffsets: [22, 22, 22, -1],
        contextInfo: [1, 1, 0, 1],
        vmStateNames: { 1: 'gc' },
        builtinsNames: null,
        paths: ['(gc):-1 < a:22', '(gc):-1 < a:22', 'a:22', '(gc):-1'],
        nodes: 5
    },
    {
        title: 'at script offsets with context info to a child node per location and context',
        scriptIds: [7, 7, 7, 7, 8, 8, 8, 8],
        scriptOffsets: [15, 15, 22, 22, 15, 15, 22, 22],
        contextInfo: [1, 2, 1, 2, 1, 2, 1, 2],
        vmStateNames: { 1: 'gc', 2: 'parser' },
        builtinsNames: null,
        paths: [
            '(gc):-1 < a:15',
            '(parser):-1 < a:15',
            '(gc):-1 < a:22',
            '(parser):-1 < a:22',
            '(gc):-1 < c:15',
            '(parser):-1 < c:15',
            '(gc):-1 < c:22',
            '(parser):-1 < c:22'
        ],
        nodes: 14
    },
    {
        title: 'of empty vectors to the root and unknown nodes only',
        scriptIds: [],
        scriptOffsets: [],
        contextInfo: [],
        vmStateNames: null,
        builtinsNames: null,
        paths: [],
        nodes: 2
    }
])('maps allocations $title', row => {
    const { dictionary, scripts } = createScripts();
    const result = createVectorLocations(
        dictionary,
        scripts,
        row.scriptIds,
        row.scriptOffsets,
        row.contextInfo,
        row.vmStateNames,
        row.builtinsNames
    )!;

    assert.deepEqual(allocationPaths(dictionary, result), row.paths);
    assert.equal(result.parent.length, row.nodes);
    assert.deepEqual(dictionary.scripts.map(script => script.url), ['first.js', 'second.js']);
});

test.each([
    { title: 'absent script ids', scriptIds: null, scriptOffsets: [22] },
    { title: 'absent script offsets', scriptIds: [7], scriptOffsets: null },
    { title: 'script ids and offsets of different lengths', scriptIds: [7, 7], scriptOffsets: [22] }
])('maps no allocation locations for $title', row => {
    const { dictionary, scripts } = createScripts();
    const result = createVectorLocations(dictionary, scripts, row.scriptIds, row.scriptOffsets, null, null, null);

    assert.equal(result, null);
});

const nestedSource = 'function outer() {\n  return [1].map(function inner(x) { return { x }; });\n}\nouter();';
const longSource = `function first() { return {}; }\nfunction second() {${' '.repeat(0x10000)}return []; }`;

test.each([
    {
        // the call frame of a location inside "outer" adds locations of "outer", including its start;
        // another location inside "outer" is added after them, then an allocation hits the start of "outer"
        title: 'added by resolving other locations',
        source: nestedSource,
        scriptOffsets: [nestedSource.indexOf('return'), nestedSource.indexOf('[1]'), nestedSource.indexOf('()')]
    },
    {
        // locations of a script are resolved in ascending offsets, ordered by both 16-bit digits of the offsets
        title: 'of offsets differing in either 16-bit digit',
        source: longSource,
        scriptOffsets: [0x10010, 20, -1, 0x10000, 15, 0x10010, 0xffff]
    }
])('maps allocations at locations $title to nodes of these locations', row => {
    const { dictionary, scripts, script } = createScriptFixture(row.source);
    const { wellKnownIndex } = dictionary.callFrames;

    // the profile's tree resolves unknown and root locations first
    dictionary.resolveLocationIndex(dictionary.callFrames[wellKnownIndex.unknown]);
    dictionary.resolveLocationIndex(dictionary.callFrames[wellKnownIndex.root]);

    const result = createVectorLocations(
        dictionary,
        scripts,
        row.scriptOffsets.map(() => 7),
        row.scriptOffsets,
        null,
        null,
        null
    )!;
    const { samples, sourceIdToNode, nodes } = result;
    const allocationLocations = [...samples].map(sample => dictionary.locations[nodes[sourceIdToNode[sample]]]);
    const single = createScriptFixture(row.source);
    const resolveOneByOne = (offset: number) => single.dictionary.resolveLocation(null, single.script, offset);

    assert.deepEqual(
        allocationLocations,
        row.scriptOffsets.map(offset => dictionary.resolveLocation(null, script, offset))
    );
    // the locations have the call frames that resolving them one by one gives
    assert.deepEqual(
        allocationLocations.map(describeLocation),
        row.scriptOffsets.map(resolveOneByOne).map(describeLocation)
    );
});

test('maps allocations of a script id given as a string the same way as of a numeric one', () => {
    const paths = (scriptIds: Array<number | string>) => {
        const { dictionary, scripts } = createScriptFixture('function f() { return {}; }');
        const result = createVectorLocations(
            dictionary,
            scripts,
            scriptIds,
            [-1, -1, 9],
            [1, 0, 2],
            { 1: 'gc', 2: 'parser' },
            null
        )!;

        return allocationPaths(dictionary, result);
    };

    assert.deepEqual(paths(['0', '0', '7']), paths([0, 0, 7]));
});

test('adds a node per sampled node and script offset after the call tree nodes, located at call sites', () => {
    const { dictionary, scripts } = createScripts();
    const callFrameA = {
        scriptId: 7,
        url: 'first.js',
        functionName: 'a',
        lineNumber: 0,
        columnNumber: 9
    };
    const callFrameB = {
        scriptId: 7,
        url: 'first.js',
        functionName: 'b',
        lineNumber: 1,
        columnNumber: 9
    };
    const a = dictionary.resolveCallFrameIndex(callFrameA, scripts);
    const b = dictionary.resolveCallFrameIndex(callFrameB, scripts);
    // the root calls "a", which calls "b" at offset 22
    const nodeParent = new Uint32Array([0, 0, 1]);
    const nodeScriptOffsets = new Int32Array([-1, -1, 22]);
    const nodeCallFrames = new Uint32Array([dictionary.callFrames.wellKnownIndex.root, a, b]);
    const samples = new Uint32Array([2, 2, 1, 2]);
    const result = createLocationsFromScriptOffsets(
        dictionary,
        nodeParent,
        nodeScriptOffsets,
        nodeCallFrames,
        samples,
        new Int32Array([51, 51, 22, 44])
    )!;

    assert.deepEqual([...result.nodes].map(index => describeLocation(dictionary.locations[index])), [
        '(root):-1', '(root):-1', 'a:22', 'b:51', 'a:22', 'b:44'
    ]);
    assert.deepEqual([...result.parent], [0, 0, 1, 2, 1, 2]);
    assert.deepEqual([...result.sourceIdToNode], [3, 4, 5]);
    assert.deepEqual([...samples], [0, 0, 1, 2]);
    assert.equal(result.dictionary, dictionary.locations);
});

test('adds no location nodes without sampled script offsets', () => {
    const { dictionary } = createScripts();
    const root = dictionary.callFrames.wellKnownIndex.root;
    const result = createLocationsFromScriptOffsets(
        dictionary,
        new Uint32Array([0]),
        new Int32Array([-1]),
        new Uint32Array([root]),
        new Uint32Array([0]),
        null
    );

    assert.equal(result, null);
});
