import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { FilterSet } from '../computations/filter-set.js';
import { SetAttributeFilter } from '../computations/attribute-filter.js';
import { PopulationFiltered } from '../computations/population.js';
import { createTimeline } from './timeline.mjs';
import { createSampledTreeSet } from '../computations/sampled-tree-set.js';
import { noopWorkHandler } from '../misc/work.js';
import { prepareLineFilters } from './filters.js';
import type { CpuProLocation } from '../types.js';

test('timeline construction leaves filters empty and integration uses already created attribution', async () => {
    const { profile, dictionary } = await createProfileFixture({ cpuOnly: true });
    const original = profile.timeline!.breakdowns[0];
    const trees = await createSampledTreeSet(dictionary, original.source, noopWorkHandler);
    const line = await createTimeline(
        { startTime: 0, endTime: 30, nodes: [], samples: [], timeDeltas: [] },
        { start: 0, end: 30, startNoSamples: 0, endNoSamples: 0, total: 30, samplesInterval: 10 },
        original.population, trees, { work: noopWorkHandler }
    );
    assert.ok(line);
    assert.ok(line.filters instanceof FilterSet);
    assert.equal(line.filters.filters.length, 0);
    assert.deepEqual(line.breakdowns[0].populationFiltered.filter.filters, []);
    prepareLineFilters(line);
    assert.ok(line.filters.get('category'));
    assert.deepEqual(line.filters.filters.map(filter => filter.key), ['category']);
});

test('later source attribution contributes options without replacing selected settings', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const original = profile.timeline!.breakdowns[0];
    const mapped = profile.timeline!.breakdowns.find(breakdown => breakdown.kind === 'call-stack-sm')!;
    const populationFiltered = new PopulationFiltered(original.population);
    const execution = { ...original, populationViewport: populationFiltered, populationFiltered: new PopulationFiltered(populationFiltered) };
    const line = { ...profile.timeline!, filters: new FilterSet(), breakdowns: [execution] };
    const settings = line.filters.add(new SetAttributeFilter('category', 'Categories', []));
    settings.setSelection('include', ['source-only']);
    const stop = prepareLineFilters(line);
    const category = line.filters.get('category') as SetAttributeFilter;
    const options = category.options.slice();
    assert.equal(category.options.some(option => option.key === 'source-only'), false);
    assert.equal(category, settings);
    assert.equal(populationFiltered.sink.total, 30);
    stop();

    const locations = mapped.source.dictionary.filter((entry): entry is CpuProLocation => 'callFrame' in entry);
    assert.equal(locations.length, mapped.source.dictionary.length);
    const source = {
        ...mapped.source,
        dictionary: locations.map(entry => ({ ...entry, callFrame: { ...entry.callFrame, category: { id: -1, name: 'source-only' } } }))
    };
    line.breakdowns.push({ ...mapped, source, populationViewport: populationFiltered, populationFiltered: execution.populationFiltered });
    const stopUpdated = prepareLineFilters(line);
    assert.equal(line.filters.get('category'), category);
    assert.deepEqual(line.filters.filters.map(filter => filter.key), ['category']);
    assert.deepEqual(category.options.map(option => option.key), [...options.map(option => option.key), 'source-only']);
    assert.deepEqual(category.selectedKeys, ['source-only']);
    assert.deepEqual(populationFiltered.samplesTotal, original.population.samplesTotal);
    const prepared = populationFiltered.filter.get('category')!;
    category.setEnabled('source-only', false);
    assert.equal(populationFiltered.sink.total, 30);
    assert.equal(prepared.accepts!(0), true);
    assert.equal(populationFiltered.filter.get('category')!.accepts!(0), false);
    stopUpdated();
});

test('integration reuses unchanged results and applies a settings batch once per population', async () => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const line = profile.memline!;
    const populations = [...new Set(line.breakdowns.map(breakdown => breakdown.populationViewport))];
    const categories = populations.map(population => population.filter.get('category'));
    const liveness = line.filters.get('allocationLiveness') as SetAttributeFilter;
    let changes = 0;
    populations.forEach(population => population.subscribe(() => changes++));
    line.filters.batch(() => {
        liveness.setSelection('include', []);
        liveness.setEnabled('alive', true);
    });
    assert.equal(changes, populations.length);
    assert.equal(populations[0].filter.get('allocationLiveness'), populations[1].filter.get('allocationLiveness'));
    populations.forEach((population, index) => assert.equal(population.filter.get('category'), categories[index]));
    const result = populations[0].filter.get('allocationLiveness');
    liveness.setSelection('include', ['alive']);
    assert.equal(populations[0].filter.get('allocationLiveness'), result);
    assert.equal(changes, populations.length);
});

test('dispatches supported attributes in input order and skips those without a handler', async () => {
    const { profile } = await createProfileFixture({
        allocationGc: [0, 1, 0, 2],
        allocationSpaces: [1, 1, 2, 2],
        allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
    });
    const memline = profile.memline!;

    for (const { attributes, expected } of [
        { attributes: memline.attributes, expected: ['allocationSpace', 'allocationLiveness'] },
        { attributes: [...memline.attributes].reverse(), expected: ['allocationLiveness', 'allocationSpace'] }
    ]) {
        const line = { ...memline, filters: new FilterSet(), attributes };
        const stop = prepareLineFilters(line);
        assert.deepEqual(line.filters.filters.map(filter => filter.key), [
            'category', ...expected
        ]);
        assert.equal(line.filters.get('allocationType'), undefined);
        assert.equal(line.filters.get('allocationGcEpoch'), undefined);
        stop();
    }
});

test('one category condition covers every attribution of each population', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const settings = line.filters.get('category') as SetAttributeFilter;
    assert.ok(settings);
    settings.setSelection('include', ['script']);
    for (const populationFiltered of new Set(line.breakdowns.map(breakdown => breakdown.populationViewport))) {
        const sources = line.breakdowns.filter(breakdown => breakdown.populationViewport === populationFiltered).map(breakdown => breakdown.source);
        assert.deepEqual(populationFiltered.filter.filters.map(filter => filter.key), ['category']);
        const accepts = populationFiltered.filter.get('category')!.accepts!;
        for (let sampleId = 0; sampleId < populationFiltered.samplesCount.length; sampleId++) {
            const matches = sources.some(source => {
                const entry = source.dictionary[source.nodes[source.sourceIdToNode[sampleId]]];
                return ('callFrame' in entry ? entry.callFrame : entry).category.name === 'script';
            });
            assert.equal(accepts(sampleId), matches);
        }
    }
});
