import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { Dictionary } from '../dictionary.js';
import { ProfileScriptsMap } from './scripts.js';
import { SourceMapping } from './source-mapping.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';

// Function ranges of original scripts are parsed on demand instead of parse workers
vi.spyOn(scriptFunctions, 'prepareScriptSources').mockResolvedValue(undefined);

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
    for (const [column, source, line, originalColumn] of mappings) {
        generator.addMapping({ generated: { line: 1, column }, original: { line, column: originalColumn }, source });
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

    return { dictionary, generatedScript, generatedFunction, generatedLocations };
}

test('original locations belong to the original functions containing them', async () => {
    const { dictionary, generatedScript, generatedFunction, generatedLocations } = createFixture();
    const sourceMapping = new SourceMapping(dictionary, {
        api: 'test',
        areas: ['team-a'],
        files: { 'a.js': [0] }
    });
    const originalLocations = await sourceMapping.mapLocations();
    const original = (index: number) => dictionary.locations[originalLocations[index]];
    const start = original(generatedFunction.location.id - 1);
    const [inner, helper, outer, noSource] = generatedLocations.map(original);

    assert.equal(sourceMapping.hasSourceMaps, true);
    assert.equal(start.script!.url, 'a.js');
    assert.equal(start.script!.originalFor, generatedScript);
    assert.equal(start.script!.module.owner.name, 'team-a');
    assert.deepEqual([start.callFrame.name, start.callFrame.start, start.callFrame.end], ['outer', originalA.indexOf('('), originalA.length]);
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

    // original scripts and their locations map to themselves
    assert.equal(originalLocations[start.id - 1], start.id - 1);
    assert.equal(dictionary.scripts.filter(script => script.originalFor === generatedScript).length, 3);
});

test('maps only locations added since the previous call and reuses original scripts', async () => {
    const { dictionary, generatedScript, generatedFunction } = createFixture();
    const sourceMapping = new SourceMapping(dictionary);
    const first = await sourceMapping.mapLocations();
    const scriptsCount = dictionary.scripts.length;
    const added = dictionary.resolveLocationIndex(generatedFunction, generatedScript, -1, 0, 25);
    const second = await sourceMapping.mapLocations();
    const original = dictionary.locations[second[added]];

    assert.equal(second.length, dictionary.locations.length);
    assert.deepEqual([...second.subarray(0, first.length)], [...first]);
    assert.equal(dictionary.scripts.length, scriptsCount);
    assert.deepEqual([original.script!.url, original.line, original.column, original.callFrame.name], ['a.js', 1, 37, 'inner']);
});

test('a dictionary without source maps maps locations to themselves', async () => {
    const dictionary = new Dictionary();
    const scriptsMap = new ProfileScriptsMap(dictionary, [{ id: 1, url: 'plain.js', source: 'function f() {}' }]);
    const location = dictionary.resolveLocationIndex(null, scriptsMap.get(1)!, -1, 0, 9);
    const sourceMapping = new SourceMapping(dictionary);
    const originalLocations = await sourceMapping.mapLocations();

    assert.equal(sourceMapping.hasSourceMaps, false);
    assert.equal(originalLocations[location], location);
    assert.deepEqual([...originalLocations], dictionary.locations.map((_, index) => index));
});
