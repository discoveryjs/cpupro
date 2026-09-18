import assert from 'node:assert/strict';
import { inject, test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { createSampledTreeSet } from './sampled-tree-set.js';
import { Population, PopulationFiltered } from './population.js';
import { createLineBreakdown } from '../lines/breakdown.js';
import { createSourceMappedBreakdown } from '../profile-sm.mjs';
import { noopWorkHandler } from '../misc/work.js';

test('preserves source identity and sparse sample IDs through source mapping', async () => {
    const { profile, dictionary, scriptsMap } = await createProfileFixture();
    const viewport = new PopulationFiltered(new Population(new Uint32Array([1, 1]), new Uint32Array([16, 32])));
    const population = new PopulationFiltered(viewport);
    const source = {
        dictionary: dictionary.locations,
        parent: new Uint32Array([0, 0, 0]),
        nodes: new Uint32Array([1, 0, dictionary.resolveLocationIndex(null, scriptsMap.get(1), 10, 0, 10)]),
        sourceIdToNode: new Int32Array([1, 2])
    };
    const originalSamples = population.population.samples;
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);
    assert.deepEqual(Object.keys(trees).sort(), ['dictionary', 'sampledTrees', 'source']);
    assert.equal(trees.source, source);
    if (!inject('useUsage')) {
        assert.equal(trees.dictionary, dictionary);
    }
    const original = await createLineBreakdown('extra', profile.memline!, population, viewport, trees, noopWorkHandler);
    const previousBreakdowns = profile.memline!.breakdowns.slice();
    const mapped = await createSourceMappedBreakdown('extra-sm', profile.memline!, dictionary, scriptsMap, original, null, noopWorkHandler);
    assert.ok(mapped);
    assert.deepEqual(profile.memline!.breakdowns, previousBreakdowns);
    assert.equal(mapped.population, population.population);
    assert.equal(mapped.populationFiltered, population);
    assert.equal(mapped.populationViewport, viewport);
    assert.equal(mapped.population.samples, originalSamples);
    assert.deepEqual([...originalSamples], [1, 1]);
    const all = mapped.locations!.all.nodes;
    const filtered = mapped.locations!.filtered.nodes;
    assert.equal(all.selfValues[0] + all.nestedValues[0], 48);
    assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 48);
    population.setRange(4, 20);
    assert.equal(all.selfValues[0] + all.nestedValues[0], 48);
    assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 16);
    population.resetRange();
    assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 48);
});
