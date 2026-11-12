import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { Dictionary } from '../dictionary.js';
import { ProfileScriptsMap } from './scripts.js';
import { SourceMapping } from './source-mapping.js';
import type { CpuProLocation, CpuProScript } from '../types.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';

// Function ranges of original scripts are parsed on demand instead of parse workers
const prepareScriptSources = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockResolvedValue(undefined);

const originalA = 'function outer() {\n  return [1].map(function inner(x) { return x; });\n}';
const originalB = 'function helper() { return 2; }';

function createFixture() {
    const generator = new SourceMapGenerator({ file: 'bundle.js' });
    const mappings: [number, string, number, number][] = [
        [0, 'a.js', 1, 9], // the start of the generated function is mapped to the name of "outer"
        [20, 'a.js', 2, 37], // "inner" is inlined
        [40, 'b.js', 1, 20], // "helper" from another source is inlined
        [60, 'a.js', 2, 2],
        [70, 'c.js', 1, 0] // no source content
    ];

    generator.setSourceContent('a.js', originalA);
    generator.setSourceContent('b.js', originalB);
    for (let i = 0; i < mappings.length; i++) {
        const [column, source, line, originalColumn] = mappings[i];

        generator.addMapping({
            generated: { line: 1, column },
            original: { line, column: originalColumn },
            source
        });
    }

    const dictionary = new Dictionary();
    const scriptsMap = new ProfileScriptsMap(dictionary, [{
        id: 1,
        url: 'bundle.js',
        source: ' '.repeat(80),
        sourceMap: JSON.parse(generator.toString())
    }]);
    const generatedScript = scriptsMap.get(1)!;
    const generatedFunction = dictionary.resolveCallFrame({
        scriptId: 1,
        url: 'bundle.js',
        functionName: 'a',
        lineNumber: 0,
        columnNumber: 0
    }, scriptsMap);
    const generatedLocations = [20, 40, 60, 70].map(column =>
        dictionary.resolveLocationIndex(generatedFunction, generatedScript, -1, 0, column)
    );
    // a tree of the generated function and the locations in it
    const tree = locationTree(dictionary, [generatedFunction.location.id - 1, ...generatedLocations]);

    return { dictionary, generatedScript, generatedFunction, generatedLocations, tree };
}

// A tree of locations, as a breakdown has
function locationTree(dictionary: Dictionary, locations: number[]) {
    return {
        dictionary: dictionary.locations,
        parent: new Uint32Array(locations.length),
        nodes: Uint32Array.from(locations),
        sourceIdToNode: new Int32Array(0)
    };
}

function describeOriginal(location: CpuProLocation) {
    return [location.script!.url, location.line, location.column, location.callFrame.name];
}

test('original locations belong to the original functions containing them', async () => {
    const { dictionary, generatedScript, generatedFunction, generatedLocations, tree } = createFixture();
    const sourceMapping = new SourceMapping(dictionary, {
        api: 'test',
        areas: ['team-a'],
        files: { 'a.js': [0] }
    });
    const originalLocations = (await sourceMapping.mapLocations(tree))!;
    const original = (index: number) => dictionary.locations[originalLocations[index]];
    const start = original(generatedFunction.location.id - 1);
    const [inner, helper, outer, noSource] = generatedLocations.map(original);

    assert.equal(sourceMapping.hasSourceMaps, true);
    assert.equal(start.script!.url, 'a.js');
    assert.equal(start.script!.originalFor, generatedScript);
    assert.equal(start.script!.module.owner.name, 'team-a');
    assert.equal(start.callFrame.name, 'outer');
    assert.equal(start.callFrame.start, originalA.indexOf('('));
    assert.equal(start.callFrame.end, originalA.length);
    assert.equal(start.scriptOffset, start.callFrame.start);

    assert.deepEqual([inner.line, inner.column], [1, 37]);
    assert.equal(inner.script, start.script);
    assert.equal(inner.callFrame.name, 'inner');

    assert.equal(helper.script!.url, 'b.js');
    assert.equal(helper.script!.module.owner.name, '(unknown)');
    assert.deepEqual([helper.line, helper.column, helper.callFrame.name], [0, 20, 'helper']);

    assert.equal(outer.callFrame, start.callFrame);

    assert.equal(noSource.script!.source, null);
    assert.equal(noSource.callFrame, dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(noSource.script!)]);

    assert.equal(dictionary.scripts.filter(script => script.originalFor === generatedScript).length, 3);
});

test('a location without a position belongs to the original function of its generated function start', async () => {
    const { dictionary, generatedFunction } = createFixture();
    const generatedNoPosition = dictionary.resolveLocation(generatedFunction);
    const tree = locationTree(dictionary, [generatedFunction.location.id - 1, generatedNoPosition.id - 1]);
    const originalLocations = (await new SourceMapping(dictionary).mapLocations(tree))!;
    const start = dictionary.locations[originalLocations[generatedFunction.location.id - 1]];
    const noPosition = dictionary.locations[originalLocations[generatedNoPosition.id - 1]];

    assert.equal(noPosition, start.callFrame.noLocLocation);
    assert.equal(noPosition.callFrame.name, 'outer');
});

test('maps only locations of the mapped trees, each once, and reuses original scripts', async () => {
    const { dictionary, generatedScript, generatedFunction, generatedLocations, tree } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const first = [...(await sourceMapping.mapLocations(tree))!];
    const scriptsCount = dictionary.scripts.length;
    const added = dictionary.resolveLocationIndex(generatedFunction, generatedScript, -1, 0, 25);
    const unmapped = dictionary.resolveLocationIndex(generatedFunction);
    const second = (await sourceMapping.mapLocations(locationTree(dictionary, [added, ...generatedLocations])))!;
    const original = dictionary.locations[second[added]];
    const mapped = [generatedFunction.location.id - 1, ...generatedLocations];
    const mappedOf = (originalLocations: ArrayLike<number>) => mapped.map(index => originalLocations[index]);

    assert.equal(second.length, dictionary.locations.length);
    assert.deepEqual(mappedOf(second), mappedOf(first));
    assert.equal(dictionary.scripts.length, scriptsCount);
    assert.deepEqual(describeOriginal(original), ['a.js', 1, 37, 'inner']);

    // a location of no mapped tree isn't looked up
    assert.equal(second[unmapped], -1);
});

test('original scripts looked up in advance are registered on mapping in the same order', async () => {
    const single = createFixture();
    const singleLocations = (await new SourceMapping(single.dictionary).mapLocations(single.tree))!;
    const { dictionary, generatedScript, generatedFunction, generatedLocations, tree } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const scriptsCount = dictionary.scripts.length;

    sourceMapping.prepareLocations(tree);
    assert.equal(dictionary.scripts.length, scriptsCount);

    const added = dictionary.resolveLocationIndex(generatedFunction, generatedScript, -1, 0, 25);
    const originalLocations = (await sourceMapping.mapLocations(locationTree(dictionary, [added])))!;
    const original = dictionary.locations[originalLocations[added]];

    const describeScript = (script: CpuProScript) => [script.id, script.url];
    const describeLocation = (location: CpuProLocation) => [
        location.script!.id,
        location.line,
        location.column,
        location.callFrame.name
    ];
    const mapped = generatedLocations.map(index => dictionary.locations[originalLocations[index]]);
    const singleMapped = single.generatedLocations.map(index =>
        single.dictionary.locations[singleLocations[index]]
    );

    assert.deepEqual(dictionary.scripts.map(describeScript), single.dictionary.scripts.map(describeScript));
    assert.deepEqual(mapped.map(describeLocation), singleMapped.map(describeLocation));
    assert.deepEqual(describeOriginal(original), ['a.js', 1, 37, 'inner']);
});

test('a dictionary without source maps maps locations to themselves', async () => {
    const dictionary = new Dictionary();
    const scriptsMap = new ProfileScriptsMap(dictionary, [{ id: 1, url: 'plain.js', source: 'function f() {}' }]);
    const location = dictionary.resolveLocationIndex(null, scriptsMap.get(1)!, -1, 0, 9);
    const sourceMapping = new SourceMapping(dictionary);
    const originalLocations = (await sourceMapping.mapLocations(locationTree(dictionary, [location, 0])))!;

    assert.equal(sourceMapping.hasSourceMaps, false);
    assert.equal(originalLocations[location], location);
    assert.equal(originalLocations[0], 0);
});

test('a tree of call frames is not mapped', async () => {
    const { dictionary } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const tree = { ...locationTree(dictionary, [1]), dictionary: dictionary.callFrames };

    assert.equal(await sourceMapping.mapLocations(tree), null);
    assert.equal(sourceMapping.hasSourceMaps, false);
});

// Generated scripts with the source map, and locations of each script at the columns of line 0
function createScriptLocations(sourceMap: unknown, scriptCount: number, columns: number[]) {
    const dictionary = new Dictionary();
    const createScript = (_: unknown, index: number) => ({
        id: index + 1,
        url: `bundle-${index}.js`,
        source: ' '.repeat(80),
        sourceMap
    });
    const scripts = Array.from({ length: scriptCount }, createScript);
    const scriptsMap = new ProfileScriptsMap(dictionary, scripts as ConstructorParameters<typeof ProfileScriptsMap>[1]);
    const locateColumns = (_: unknown, index: number) => {
        const script = scriptsMap.get(index + 1)!;

        return columns.map(column => dictionary.resolveLocationIndex(null, script, -1, 0, column));
    };
    const locations = Array.from({ length: scriptCount }, locateColumns);

    return { dictionary, locations, tree: locationTree(dictionary, locations.flat()) };
}

test.each([
    // column 0 is mapped, column 10 has no original position
    { name: 'a segment without an original position', mappings: 'AAAA,U', sources: ['a.js'], column: 10 },
    { name: 'a source index missing from the map', mappings: 'ACAA', sources: ['a.js'], column: 0 }
])('a location on $name maps to itself', async row => {
    const { mappings, sources, column } = row;
    const sourceMap = {
        version: 3,
        sources,
        sourcesContent: sources.map(() => originalB),
        names: [],
        mappings
    };
    const { dictionary, locations, tree } = createScriptLocations(sourceMap, 1, [column]);
    const originalLocations = (await new SourceMapping(dictionary).mapLocations(tree))!;

    assert.equal(originalLocations[locations[0][0]], locations[0][0]);
});

test('a source listed twice gives one original script per generated script', async () => {
    const sourceMap = {
        version: 3,
        sources: ['a.js', 'a.js'],
        sourcesContent: [originalB, originalB],
        names: [],
        mappings: 'AAAA,UCAA'
    };
    const { dictionary, locations, tree } = createScriptLocations(sourceMap, 2, [0, 10]);
    const originalLocations = (await new SourceMapping(dictionary).mapLocations(tree))!;
    const originalScript = (location: number) => dictionary.locations[originalLocations[location]].script;
    const originalScripts = locations.map(scriptLocations => scriptLocations.map(originalScript));
    const scriptsOfSource = dictionary.scripts.filter(script => script.url === 'a.js');

    assert.equal(originalScripts[0][0], originalScripts[0][1]);
    assert.equal(originalScripts[1][0], originalScripts[1][1]);
    assert.notEqual(originalScripts[0][0], originalScripts[1][0]);
    assert.deepEqual(scriptsOfSource.map(script => script.originalFor!.url), ['bundle-0.js', 'bundle-1.js']);
});

test('original scripts start parsing once per lookup, mapping waits for the parsing', async () => {
    let finishParsing = () => {};
    const { dictionary, tree } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const parsing = new Promise<undefined>(resolve => finishParsing = () => resolve(undefined));

    prepareScriptSources.mockClear();
    prepareScriptSources.mockReturnValueOnce(parsing);

    let mapped = false;
    const mapping = sourceMapping.mapLocations(tree).then(() => mapped = true);

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(mapped, false);
    finishParsing();
    await mapping;

    assert.equal(prepareScriptSources.mock.calls.length, 1);
    assert.deepEqual([...prepareScriptSources.mock.calls[0][0]].map(script => script.url), ['a.js', 'b.js', 'c.js']);

    // Without new locations there is nothing to parse
    await sourceMapping.mapLocations(tree);
    assert.equal(prepareScriptSources.mock.calls.length, 1);
});

test('mapping resolves locations of a lookup while original scripts of a later lookup are parsing', async () => {
    let finishParsing = () => {};
    const { dictionary, generatedScript, generatedFunction, tree } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const parsing = new Promise<undefined>(resolve => finishParsing = () => resolve(undefined));
    const callFrameNames = () => dictionary.callFrames.map(callFrame => callFrame.name);

    sourceMapping.prepareLocations(tree);
    const added = dictionary.resolveLocationIndex(generatedFunction, generatedScript, -1, 0, 25);
    const addedTree = locationTree(dictionary, [added]);
    prepareScriptSources.mockReturnValueOnce(parsing);
    sourceMapping.prepareLocations(addedTree);

    let mapped = false;
    const mapping = sourceMapping.mapLocations(addedTree);
    mapping.then(() => mapped = true);

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(mapped, false);
    assert.ok(callFrameNames().includes('helper'));

    finishParsing();
    const originalLocations = (await mapping)!;

    assert.deepEqual(describeOriginal(dictionary.locations[originalLocations[added]]), ['a.js', 1, 37, 'inner']);
});
