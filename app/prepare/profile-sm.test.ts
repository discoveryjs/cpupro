import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { createSampledTreeSet } from './computations/sampled-tree-set.js';
import { Population, PopulationFiltered } from './computations/population.js';
import { createLineBreakdown } from './lines/breakdown.js';
import { noopWorkHandler } from './misc/work.js';
import { SourceMapping } from './preprocessing/source-mapping.js';
import { createSourceMappedBreakdown } from './profile-sm.mjs';
import * as scriptFunctions from './misc/script-function-resolution.js';

// Function ranges of original scripts are parsed on demand instead of parse workers
vi.spyOn(scriptFunctions, 'prepareScriptSources').mockResolvedValue(undefined);

test('a source-mapped breakdown attributes generated functions to the original functions', async () => {
    const { profile, dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true, noSourceMap: true });
    const compiled = scriptsMap.get(1)!;
    const source = 'function first() { return 1; }\nfunction second() { return 2; }';
    const generator = new SourceMapGenerator({ file: 'compiled.js' });

    generator.setSourceContent('original.js', source);
    // the generated functions are mapped to the names of the original functions
    for (const [column, line] of [[0, 1], [20, 2]]) {
        generator.addMapping({ generated: { line: 1, column }, original: { line, column: 9 }, source: 'original.js' });
    }
    compiled.sourceMap = JSON.parse(generator.toString());

    const line = profile.timeline!;
    const originalLocations = await new SourceMapping(dictionary).mapLocations();
    const mapped = await createSourceMappedBreakdown('call-stack-sm', line, line.breakdowns[0], dictionary, originalLocations, noopWorkHandler);
    const callFrames = mapped!.callFrames.all.dict.entries
        .filter(({ entry }) => entry.script?.originalFor === compiled)
        .map(({ entry, selfValue }) => [entry.name, entry.start, entry.end, selfValue]);

    assert.deepEqual(callFrames, [
        ['first', source.indexOf('('), source.indexOf('\n'), 20],
        ['second', source.lastIndexOf('('), source.length, 10]
    ]);
});

test('a source-mapped breakdown shares the populations of its original breakdown and keeps sparse sample IDs', async () => {
    const { profile, dictionary, scriptsMap, sourceMapping } = await createProfileFixture();
    const line = profile.memline!;
    // Sample ID 0 has no events
    const viewport = new PopulationFiltered(new Population(new Uint32Array([1, 1]), new Uint32Array([16, 32])));
    const population = new PopulationFiltered(viewport);
    const window = new PopulationFiltered(viewport.population);
    const samples = population.population.samples;
    const source = {
        dictionary: dictionary.locations,
        parent: new Uint32Array([0, 0, 0]),
        nodes: new Uint32Array([1, 0, dictionary.resolveLocationIndex(null, scriptsMap.get(1), 10, 0, 10)]),
        sourceIdToNode: new Int32Array([1, 2])
    };
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);
    const original = await createLineBreakdown('extra', line, population, viewport, window, trees, noopWorkHandler);
    const breakdowns = line.breakdowns.slice();
    const mapped = await createSourceMappedBreakdown('extra-sm', line, original, dictionary, await sourceMapping.mapLocations(), noopWorkHandler);

    assert.ok(mapped);
    assert.deepEqual(line.breakdowns, breakdowns);
    assert.equal(mapped.population, population.population);
    assert.equal(mapped.populationViewport, viewport);
    assert.equal(mapped.populationWindow, window);
    assert.equal(mapped.populationFiltered, population);
    assert.equal(mapped.population.samples, samples);
    assert.deepEqual([...samples], [1, 1]);

    const all = mapped.locations!.all.nodes;
    const filtered = mapped.locations!.filtered.nodes;

    assert.equal(all.selfValues[0] + all.nestedValues[0], 16 + 32);
    assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 16 + 32);

    population.setRange(4, 20);
    assert.equal(all.selfValues[0] + all.nestedValues[0], 16 + 32);
    assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 20 - 4);
});
