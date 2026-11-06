import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { createSampledTreeSet } from './computations/sampled-tree-set.js';
import { Population, PopulationFiltered } from './computations/population.js';
import { createLineBreakdown } from './lines/breakdown.js';
import { noopWorkHandler } from './misc/work.js';
import { getFunctionAtScriptOffset } from './misc/script-function-resolution.js';
import { createSourceMappedBreakdown } from './profile-sm.mjs';

test('source-mapped frames retain source declaration ends when mappings point at names', async () => {
    const { profile, dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true, noSourceMap: true });
    const compiled = scriptsMap.get(1)!;
    const source = 'function first() { return 1; }\nfunction second() { return 2; }';
    const generator = new SourceMapGenerator({ file: 'compiled.js' });

    generator.setSourceContent('original.js', source);
    for (const [column, line] of [[0, 1], [20, 2]]) {
        generator.addMapping({ generated: { line: 1, column }, original: { line, column: 9 }, source: 'original.js' });
    }
    compiled.sourceMap = JSON.parse(generator.toString());

    // Function ranges of the original script are parsed before source mapping, as source preparation does
    const original = scriptsMap.resolveOriginalScript('original.js', source, compiled);
    getFunctionAtScriptOffset(original, 0);

    const line = profile.timeline!;
    await createSourceMappedBreakdown('call-stack-sm', line, dictionary, scriptsMap, line.breakdowns[0], null, noopWorkHandler);
    const first = compiled.callFrames.find(frame => frame.name === 'first')!.__originalCallFrame!;
    const second = compiled.callFrames.find(frame => frame.name === 'second')!.__originalCallFrame!;

    assert.equal(first.script, original);
    assert.equal(first.start, source.indexOf('first'));
    assert.equal(first.end, source.indexOf('\n'));
    assert.equal(second.end, source.length);
});

test('a source-mapped breakdown shares the populations of its original breakdown and keeps sparse sample IDs', async () => {
    const { profile, dictionary, scriptsMap } = await createProfileFixture();
    const line = profile.memline!;
    // Sample ID 0 has no events
    const viewport = new PopulationFiltered(new Population(new Uint32Array([1, 1]), new Uint32Array([16, 32])));
    const population = new PopulationFiltered(viewport);
    const samples = population.population.samples;
    const source = {
        dictionary: dictionary.locations,
        parent: new Uint32Array([0, 0, 0]),
        nodes: new Uint32Array([1, 0, dictionary.resolveLocationIndex(null, scriptsMap.get(1), 10, 0, 10)]),
        sourceIdToNode: new Int32Array([1, 2])
    };
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);
    const original = await createLineBreakdown('extra', line, population, viewport, trees, noopWorkHandler);
    const breakdowns = line.breakdowns.slice();
    const mapped = await createSourceMappedBreakdown('extra-sm', line, dictionary, scriptsMap, original, null, noopWorkHandler);

    assert.ok(mapped);
    assert.deepEqual(line.breakdowns, breakdowns);
    assert.equal(mapped.population, population.population);
    assert.equal(mapped.populationViewport, viewport);
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
