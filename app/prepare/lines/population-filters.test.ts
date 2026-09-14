import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { SetAttributeFilter } from '../computations/attribute-filter.js';
import { PopulationFiltered } from '../computations/population.js';
import { prepareLineFilters } from './filters.js';
import { FilterSet } from '../computations/filter-set.js';

test('binds filters without a breakdown and preserves source category attribution for every bucket', async () => {
    const { profile } = await createProfileFixture();

    for (const line of profile.lines) {
        for (const breakdown of line.breakdowns.filter(entry => !entry.kind.endsWith('-sm'))) {
            const { population, source, categories } = breakdown;
            assert.ok(categories);
            const filtered = new PopulationFiltered(population);
            const preparedLine = { ...line, filters: new FilterSet(), breakdowns: [{ ...breakdown, source, populationFiltered: filtered }] };
            prepareLineFilters(preparedLine);
            const category = preparedLine.filters.get('category') as SetAttributeFilter;

            assert.equal(filtered.filter.get('category')!.key, category.key);
            assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
            assert.deepEqual(filtered.samples, population.samples);
            for (const option of category.options) {
                category.setSelection('include', [option.key]);
                const accepts = filtered.filter.get('category')!.accepts!;

                for (let sampleId = 0; sampleId < population.samplesCount.length; sampleId++) {
                    const categoryNode = categories.tree.nodes[categories.sampleToNode[sampleId]];
                    assert.equal(accepts(sampleId), categories.tree.dictionary[categoryNode].name === option.key);
                }
            }
        }
    }
});

test('registers only available filters and shares their state across source-mapped breakdowns', async () => {
    const { profile } = await createProfileFixture();
    for (const line of profile.lines) {
        for (const breakdown of line.breakdowns) {
            assert.deepEqual(breakdown.populationFiltered.filter.filters.map(filter => filter.key), ['category']);
        }
        const first = line.breakdowns[0];
        const mapped = line.breakdowns.find(breakdown => breakdown.kind === `${first.kind}-sm`)!;
        assert.equal(first.populationFiltered.filter, mapped.populationFiltered.filter);
    }
});

test('does not register event filters with incomplete data or a missing dictionary', async () => {
    const { profile } = await createProfileFixture({
        allocationGc: [0],
        allocationSpaces: [1, 1, 1, 1]
    });
    for (const breakdown of profile.memline!.breakdowns) {
        assert.deepEqual(breakdown.populationFiltered.filter.filters.map(filter => filter.key), ['category']);
    }
});

test('filters liveness and space precisely within the same sample ID and composes with categories/range', async () => {
    const { profile } = await createProfileFixture({
        mapping: [0, 4, 4],
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const line = profile.memline!;
    for (const kind of ['call-stack', 'location']) {
        const breakdown = line.breakdowns.find(entry => entry.kind === kind)!;
        const mapped = line.breakdowns.find(entry => entry.kind === `${kind}-sm`)!;
        const population = breakdown.populationFiltered;
        const manager = line.filters;
        manager.allowAll();
        assert.deepEqual(manager.filters.map(filter => filter.key), ['category', 'allocationSpace', 'allocationLiveness']);
        const liveness = manager.get('allocationLiveness') as SetAttributeFilter;
        const space = manager.get('allocationSpace') as SetAttributeFilter;
        const category = manager.get('category') as SetAttributeFilter;
        let updates = 0;
        const unsubscribe = population.subscribe(() => updates++);
        manager.batch(() => {
            liveness.setEnabled('gced', false); space.setEnabled('old_space', false);
        });
        assert.equal(updates, 1);
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 16);
        assert.equal(population.buffer.samples[0], population.population.samples[0]);
        assert.deepEqual([...population.samples.subarray(1)], [population.sinkId, population.sinkId, population.sinkId]);
        assert.equal(population.filter, mapped.populationFiltered.filter);
        assert.equal(population.sink.total, 144);
        assert.equal(mapped.callFrames!.filtered.nodes.selfValues[0] + mapped.callFrames!.filtered.nodes.nestedValues[0], 16);
        assert.equal(population.samplesMask.length, population.population.samplesCount.length);

        population.setRange(8, 80);
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 8);
        assert.equal(population.sink.total, 64);
        space.reset();
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 40);
        manager.batch(() => category.options.forEach(option => category.setEnabled(option.key, false)));
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
        manager.allowAll();
        assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 72);
        assert.equal(population.sink.total, 0);
        assert.equal(population.rangeStart, 8);
        assert.ok(manager.filters.every(filter => !filter.active));
        liveness.setEnabled('alive', false);
        liveness.allowAll();
        assert.equal(population.sink.total, 0);
        population.resetRange();
        assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
        unsubscribe();
    }
    assert.deepEqual(profile.timeline!.filters.filters.map(filter => filter.key), ['category']);
});
