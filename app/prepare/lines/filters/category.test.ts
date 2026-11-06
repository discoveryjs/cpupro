import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../../test/fixtures/profile.js';
import { Population, PopulationFiltered } from '../../computations/population.js';
import { FilterSet } from '../../computations/filter-set.js';
import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import { prepareLineFilters } from '../filters.js';
import { createCategoryFilter } from './category.js';

// Two populations of two samples. The first one is attributed by two sources:
// sample 0 is "script" in one source and "source-only" in another, sample 1 is "script" in both.
// Each sample of the second population has its own category.
async function createBreakdowns() {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const timeline = profile.timeline!;
    const original = timeline.breakdowns[0];
    const entry = original.source.dictionary[0];
    const callFrame = 'callFrame' in entry ? entry.callFrame : entry;
    const createSource = (names: string[]) => ({
        dictionary: names.map((name, index) => ({ ...callFrame, category: { id: index, name } })),
        parent: new Uint32Array([0, 0]),
        nodes: new Uint32Array([0, 1]),
        sourceIdToNode: new Int32Array([0, 1])
    });
    const createBreakdown = (values: number[], names: string[]) => {
        const viewport = new PopulationFiltered(new Population(new Uint32Array([0, 1]), new Uint32Array(values)));

        return {
            ...original,
            population: viewport.population,
            populationViewport: viewport,
            populationFiltered: new PopulationFiltered(viewport),
            source: createSource(names)
        };
    };
    const execution = createBreakdown([10, 20], ['script', 'script']);
    const mapped = { ...execution, kind: 'call-stack-sm', source: createSource(['source-only', 'script']) };
    const other = createBreakdown([30, 40], ['other', 'last']);

    return { timeline, execution, mapped, other };
}

test('options are the categories of every source attributing a population', async () => {
    const { execution, mapped, other } = await createBreakdowns();

    assert.deepEqual(createCategoryFilter([execution, mapped]).settings.options.map(option => option.key), ['script', 'source-only']);
    assert.deepEqual(createCategoryFilter([other]).settings.options.map(option => option.key), ['other', 'last']);
});

test.each([
    { mode: 'include', keys: ['source-only'], accepted: [true, false] },
    { mode: 'exclude', keys: ['source-only'], accepted: [false, true] },
    { mode: 'include', keys: ['script'], accepted: [true, true] },
    { mode: 'exclude', keys: ['script'], accepted: [false, false] },
    { mode: 'include', keys: [], accepted: [false, false] }
] as const)('$mode $keys matches a sample by any of its attributions', async ({ mode, keys, accepted }) => {
    const { execution, mapped } = await createBreakdowns();
    const filter = createCategoryFilter([execution, mapped]);

    filter.settings.setSelection(mode, [...keys]);
    const accepts = filter.compile(filter.settings);

    assert.deepEqual([accepts(0), accepts(1)], accepted);
});

test.each([false, true])('a line shares one category setting across populations (reversed breakdowns: %s)', async reverse => {
    const { timeline, execution, mapped, other } = await createBreakdowns();
    const breakdowns = [execution, mapped, other];
    const line = { ...timeline, filters: new FilterSet(), breakdowns: reverse ? breakdowns.reverse() : breakdowns };

    prepareLineFilters(line);
    const settings = line.filters.get('category') as SetAttributeFilter;

    assert.deepEqual(settings.options.map(option => option.key).sort(), ['last', 'other', 'script', 'source-only']);

    settings.setSelection('include', ['source-only']);

    assert.deepEqual([...execution.populationViewport.samplesTotal], [10, 0]);
    assert.deepEqual([...other.populationViewport.samplesTotal], [0, 0]);
});
