import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { SetAttributeFilter } from '../computations/attribute-filter.js';

test('shared category settings do not imply the same event participation for distinct attribution bases', async () => {
    const { profile } = await createProfileFixture({ mapping: [0, 4, 4], contexts: [1, 2, 1, 0] });
    const line = profile.memline!;
    const stack = line.breakdowns.find(breakdown => breakdown.kind === 'call-stack')!;
    const location = line.breakdowns.find(breakdown => breakdown.kind === 'location')!;
    const category = line.filters.get('category') as SetAttributeFilter;
    category.setSelection('include', ['script']);

    const acceptedEvents = [stack, location].map(breakdown => {
        const accepts = breakdown.populationViewport.filter.get('category')!.accepts!;

        return Array.from(breakdown.population.samples, sampleId => accepts(sampleId));
    });

    assert.notDeepEqual(acceptedEvents[0], acceptedEvents[1]);
    for (const [index, breakdown] of [stack, location].entries()) {
        const { samples, sinkId } = breakdown.populationFiltered;
        assert.deepEqual(Array.from(samples, sampleId => sampleId !== sinkId), acceptedEvents[index]);
    }
});

test('line owns one setting per attribute across distinct populations and source-mapped breakdowns', async () => {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        contexts: [1, 2, 1, 0],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const line = profile.memline!;
    const originals = line.breakdowns.filter(breakdown => !breakdown.kind.endsWith('-sm'));
    assert.equal(originals.length, 2);
    const populations = originals.map(breakdown => breakdown.populationFiltered);
    const updates = [0, 0];
    populations.forEach((population, index) => population.subscribe(() => updates[index]++));
    assert.deepEqual(line.filters.filters.map(filter => filter.key), ['category', 'allocationSpace', 'allocationLiveness']);
    for (const breakdown of line.breakdowns) {
        for (const settings of line.filters.filters) {
            assert.equal(breakdown.populationViewport.filter.get(settings.key)!.key, settings.key);
            assert.equal(breakdown.populationFiltered.filter.get(settings.key), undefined);
        }
    }
    assert.notEqual(originals[0].populationViewport.filter.get('category'), originals[1].populationViewport.filter.get('category'));
    assert.notEqual(populations[0].samplesMask, populations[1].samplesMask);
    const liveness = line.filters.get('allocationLiveness') as SetAttributeFilter;
    const space = line.filters.get('allocationSpace') as SetAttributeFilter;
    line.filters.batch(() => {
        liveness.setSelection('include', ['alive']);
        space.setSelection('exclude', ['old_space']);
    });
    assert.deepEqual(updates, [1, 1]);
    for (const key of ['allocationLiveness', 'allocationSpace']) {
        assert.equal(originals[0].populationViewport.filter.get(key), originals[1].populationViewport.filter.get(key));
    }
    for (const breakdown of line.breakdowns) {
        const population = breakdown.populationFiltered;
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 16);
        assert.equal(population.sink.total, 144);
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 16);
    }
    populations[0].setRange(8, 80);
    line.filters.reset();
    assert.equal(liveness.mode, 'include');
    assert.ok(populations.every(population => population.samplesTotal.every(value => value === 0)));
    line.filters.allowAll();
    assert.equal(populations[0].rangeStart, 8);
    assert.equal(populations[0].samplesTotal.reduce((sum, value) => sum + value, 0), 72);
    assert.equal(populations[1].samplesTotal.reduce((sum, value) => sum + value, 0), 160);
    const category = line.filters.get('category') as SetAttributeFilter;
    category.setSelection('include', ['script']);
    assert.ok(profile.timeline!.filters.filters.every(filter => !filter.active));
    for (const breakdown of originals) {
        const binding = breakdown.populationViewport.filter.get('category')!;
        const accepts = binding.accepts!;
        const categories = breakdown.categories!;
        for (let sampleId = 0; sampleId < binding.size; sampleId++) {
            const categoryNode = categories.tree.nodes[categories.sampleToNode[sampleId]];
            assert.equal(accepts(sampleId), categories.tree.dictionary[categoryNode].name === 'script');
        }
    }
});
