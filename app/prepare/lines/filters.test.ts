import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { FilterSet } from '../computations/filter-set.js';
import { SetAttributeFilter } from '../computations/attribute-filter.js';
import { PopulationFiltered } from '../computations/population.js';
import { createSampledTreeSet } from '../computations/sampled-tree-set.js';
import { noopWorkHandler } from '../misc/work.js';
import type { CpuProLocation } from '../types.js';
import { createTimeline } from './timeline.mjs';
import { prepareLineFilters } from './filters.js';

// Fixture allocation events weigh 16, 32, 48 and 64 bytes.
// Events 0 and 2 are alive, event 1 is short-lived and event 3 long-lived; events 0 and 1 are in new space.
const allocationEvents = {
    allocationGc: [0, 1, 0, 2],
    allocationSpaces: [1, 1, 2, 2],
    allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
};

function sum(values: ArrayLike<number>) {
    let total = 0;

    for (let index = 0; index < values.length; index++) {
        total += values[index];
    }

    return total;
}

test('a created timeline has no filters until they are prepared from its attribution', async () => {
    const { profile, dictionary } = await createProfileFixture({ cpuOnly: true });
    const { population, source } = profile.timeline!.breakdowns[0];
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);
    const line = await createTimeline(
        { startTime: 0, endTime: 30, nodes: [], samples: [], timeDeltas: [] },
        { start: 0, end: 30, startNoSamples: 0, endNoSamples: 0, total: 30, samplesInterval: 10 },
        population, trees, { work: noopWorkHandler }
    );

    assert.ok(line);
    assert.deepEqual(line.filters.filters.map(filter => filter.key), []);

    prepareLineFilters(line);

    assert.deepEqual(line.filters.filters.map(filter => filter.key), ['category']);
});

test.each([
    {
        order: 'input',
        reverse: false,
        expected: ['category', 'allocationSpace', 'allocationLifespan', 'allocationGcEpoch']
    },
    {
        order: 'reversed',
        reverse: true,
        expected: ['category', 'allocationGcEpoch', 'allocationLifespan', 'allocationSpace']
    }
])('registers category and attribute filters in $order attribute order', async ({ reverse, expected }) => {
    const { profile } = await createProfileFixture(allocationEvents);
    const attributes = [...profile.memline!.attributes];
    const line = { ...profile.memline!, filters: new FilterSet(), attributes: reverse ? attributes.reverse() : attributes };

    prepareLineFilters(line);

    assert.deepEqual(line.filters.filters.map(filter => filter.key), expected);
    assert.deepEqual(profile.timeline!.filters.filters.map(filter => filter.key), ['category']);
});

test.each([
    { name: 'lifespan and GC epoch without a value for every event', options: { allocationGc: [0] } },
    { name: 'space without a value for every event', options: { allocationSpaces: [1], allocationSpaceNames: { 1: 'new_space' } } },
    { name: 'space without option names', options: { allocationSpaces: [1, 1, 1, 1] } }
])('skips $name', async ({ options }) => {
    const { profile } = await createProfileFixture(options);

    assert.deepEqual(profile.memline!.filters.filters.map(filter => filter.key), ['category']);
});

test('every attribute but identity-like ones gets a filter with an option per dictionary entry', async () => {
    const { profile } = await createProfileFixture();
    const attributes = [
        {
            name: 'allocationType' as const,
            values: Uint32Array.of(0, 1, 1, 0),
            dict: ['STRING', 'FIXED_ARRAY']
        },
        {
            name: 'allocationCodeType' as const,
            values: Uint8Array.of(0, 0, 1, 2),
            dict: ['Ignition', 'Turbofan', 'Builtin']
        },
        {
            name: 'allocationOwner' as const,
            values: Uint32Array.of(0, 1, 2, 3),
            dict: [null, { scriptId: 1, start: 0 }, { scriptId: 1, start: 10 }, { scriptId: 2, start: 0 }]
        }
    ];
    const line = { ...profile.memline!, filters: new FilterSet(), attributes };

    prepareLineFilters(line);

    const typeFilter = line.filters.get('allocationType') as SetAttributeFilter;
    const codeTypeFilter = line.filters.get('allocationCodeType') as SetAttributeFilter;

    assert.deepEqual(
        line.filters.filters.map(filter => filter.key),
        ['category', 'allocationType', 'allocationCodeType']
    );
    assert.deepEqual(
        typeFilter.options.map(option => option.key),
        ['STRING', 'FIXED_ARRAY']
    );
    assert.deepEqual(
        codeTypeFilter.options.map(option => option.label),
        ['Ignition', 'Turbofan', 'Builtin']
    );
});

test.each([
    { name: 'with a value for every event', values: [1, 1, 2, 0], expected: ['category', 'allocationCompilationStage'] },
    { name: 'without a value for every event', values: [1], expected: ['category'] }
])('registers the compilation stage filter only $name', async ({ values, expected }) => {
    const { profile } = await createProfileFixture();
    const attributes = [{ name: 'allocationCompilationStage' as const, values: Uint8Array.from(values), dict: ['none', 'Compile', 'Finalize'] }];
    const line = { ...profile.memline!, filters: new FilterSet(), attributes };

    prepareLineFilters(line);

    assert.deepEqual(line.filters.filters.map(filter => filter.key), expected);
});

test('filters apply to the viewport and window populations shared with source-mapped breakdowns', async () => {
    const { profile } = await createProfileFixture(allocationEvents);

    for (const line of profile.lines) {
        const keys = line.filters.filters.map(filter => filter.key);

        for (const breakdown of line.breakdowns) {
            assert.deepEqual(breakdown.populationViewport.filter.filters.map(filter => filter.key), keys);
            assert.deepEqual(breakdown.populationWindow.filter.filters.map(filter => filter.key), keys);
            assert.deepEqual(breakdown.populationFiltered.filter.filters, []);
        }

        for (const breakdown of line.breakdowns.filter(entry => !entry.kind.endsWith('-sm'))) {
            const mapped = line.breakdowns.find(entry => entry.kind === breakdown.kind + '-sm')!;

            assert.equal(breakdown.populationViewport.filter, mapped.populationViewport.filter);
            assert.equal(breakdown.populationWindow, mapped.populationWindow);
        }
    }
});

test('category filter accepts the samples of selected categories of each breakdown', async () => {
    const { profile } = await createProfileFixture();

    for (const line of profile.lines) {
        const category = line.filters.get('category') as SetAttributeFilter;

        for (const { populationViewport, categories } of line.breakdowns) {
            for (const option of category.options) {
                category.setSelection('include', [option.key]);
                const { values, accepts } = populationViewport.filter.get('category')!;

                for (let sampleId = 0; sampleId < populationViewport.samplesCount.length; sampleId++) {
                    const node = categories!.tree.nodes[categories!.sampleToNode[sampleId]];

                    assert.equal(accepts![values![sampleId]] === 1, categories!.tree.dictionary[node].name === option.key);
                }
            }
        }
    }
});

test('event filters select individual allocations of a shared sample', async () => {
    // Every allocation of the call-stack breakdown is attributed to the same sample
    const { profile } = await createProfileFixture({ mapping: [0, 4, 4], ...allocationEvents });
    const line = profile.memline!;
    const lifespan = line.filters.get('allocationLifespan') as SetAttributeFilter;
    const space = line.filters.get('allocationSpace') as SetAttributeFilter;

    line.filters.batch(() => {
        lifespan.setEnabled('short-lived', false);
        lifespan.setEnabled('long-lived', false);
        space.setEnabled('old_space', false);
    });

    // Only event 0 is alive and in new space
    for (const { populationFiltered, callFrames } of line.breakdowns) {
        const { selfValues, nestedValues } = callFrames!.filtered.nodes;

        assert.equal(sum(populationFiltered.samplesTotal), 16);
        assert.equal(populationFiltered.sink.total, sum(line.values) - 16);
        assert.equal(selfValues[0] + nestedValues[0], 16);
    }
});

test('a settings batch updates each population once and recompiles only changed settings', async () => {
    const { profile } = await createProfileFixture(allocationEvents);
    const line = profile.memline!;
    const lifespan = line.filters.get('allocationLifespan') as SetAttributeFilter;
    const space = line.filters.get('allocationSpace') as SetAttributeFilter;
    const populations = [...new Set(line.breakdowns.map(breakdown => breakdown.populationViewport))];
    const categories = populations.map(population => population.filter.get('category'));
    const updates = populations.map(() => 0);

    for (const [index, population] of populations.entries()) {
        population.subscribe(() => updates[index]++);
    }

    line.filters.batch(() => {
        lifespan.setSelection('include', ['alive']);
        space.setSelection('exclude', ['old_space']);
    });

    assert.deepEqual(updates, [1, 1]);
    for (const [index, population] of populations.entries()) {
        assert.equal(population.filter.get('category'), categories[index]);
    }

    const result = populations[0].filter.get('allocationLifespan');

    lifespan.setSelection('include', ['alive']);

    assert.deepEqual(updates, [1, 1]);
    assert.equal(populations[0].filter.get('allocationLifespan'), result);
});

test('later attribution adds category options without replacing the settings or their selection', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const original = profile.timeline!.breakdowns[0];
    const mapped = profile.timeline!.breakdowns.find(breakdown => breakdown.kind === 'call-stack-sm')!;
    const viewport = new PopulationFiltered(original.population);
    const execution = { ...original, populationViewport: viewport, populationFiltered: new PopulationFiltered(viewport) };
    const line = { ...profile.timeline!, filters: new FilterSet(), breakdowns: [execution] };
    const category = line.filters.add(new SetAttributeFilter('category', 'Categories', []));
    const total = sum(original.population.samplesTotal);

    category.setSelection('include', ['source-only']);
    const stop = prepareLineFilters(line);
    const options = category.options.map(option => option.key);

    assert.equal(line.filters.get('category'), category);
    assert.equal(options.includes('source-only'), false);
    assert.equal(viewport.sink.total, total);
    stop();

    const locations = mapped.source.dictionary as CpuProLocation[];
    const source = {
        ...mapped.source,
        dictionary: locations.map(entry => ({ ...entry, callFrame: { ...entry.callFrame, category: { id: -1, name: 'source-only' } } }))
    };

    line.breakdowns.push({ ...mapped, source, populationViewport: viewport, populationFiltered: execution.populationFiltered });
    prepareLineFilters(line);

    assert.equal(line.filters.get('category'), category);
    assert.deepEqual(category.options.map(option => option.key), [...options, 'source-only']);
    assert.deepEqual(category.selectedKeys, ['source-only']);
    assert.equal(viewport.sink.total, 0);
    assert.deepEqual(viewport.samplesTotal, original.population.samplesTotal);
});
