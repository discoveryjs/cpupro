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
function optionKeys(filter: SetAttributeFilter) {
    return filter.options.map(option => option.key);
}

async function createBreakdowns() {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const timeline = profile.timeline!;
    const original = timeline.breakdowns[0];
    const entry = original.source.dictionary[0];
    const callFrame = 'callFrame' in entry
        ? entry.callFrame
        : entry;
    const categoryCallFrame = (name: string, id: number) => ({
        ...callFrame,
        category: { id, name }
    });
    const createSource = (names: string[]) => ({
        dictionary: names.map(categoryCallFrame),
        parent: new Uint32Array([0, 0]),
        nodes: new Uint32Array([0, 1]),
        sourceIdToNode: new Int32Array([0, 1])
    });
    const createBreakdown = (values: number[], names: string[]) => {
        const population = new Population(new Uint32Array([0, 1]), new Uint32Array(values));
        const viewport = new PopulationFiltered(population);

        return {
            ...original,
            population: viewport.population,
            populationViewport: viewport,
            populationFiltered: new PopulationFiltered(viewport),
            source: createSource(names)
        };
    };
    const execution = createBreakdown([10, 20], ['script', 'script']);
    const mapped = {
        ...execution,
        kind: 'call-stack-sm',
        source: createSource(['source-only', 'script'])
    };
    const other = createBreakdown([30, 40], ['other', 'last']);

    return { timeline, execution, mapped, other };
}

test('options are the categories of every source attributing a population', async () => {
    const { execution, mapped, other } = await createBreakdowns();

    assert.deepEqual(optionKeys(createCategoryFilter([execution, mapped]).settings), ['script', 'source-only']);
    assert.deepEqual(optionKeys(createCategoryFilter([other]).settings), ['other', 'last']);
});

test.each([
    { mode: 'include', keys: ['source-only'], accepted: [true, false] },
    { mode: 'exclude', keys: ['source-only'], accepted: [false, true] },
    { mode: 'include', keys: ['script'], accepted: [true, true] },
    { mode: 'exclude', keys: ['script'], accepted: [false, false] },
    { mode: 'include', keys: [], accepted: [false, false] }
] as const)('$mode $keys matches a sample by any of its attributions', async row => {
    const { execution, mapped } = await createBreakdowns();
    const filter = createCategoryFilter([execution, mapped]);

    filter.settings.setSelection(row.mode, [...row.keys]);
    const accepts = filter.compile(filter.settings);
    const accepted = [
        accepts[filter.values![0]] === 1,
        accepts[filter.values![1]] === 1
    ];

    assert.deepEqual(accepted, row.accepted);
});

test.each([false, true])('a line shares one category setting across populations (reversed: %s)', async reverse => {
    const { timeline, execution, mapped, other } = await createBreakdowns();
    const breakdowns = [execution, mapped, other];
    const line = {
        ...timeline,
        filters: new FilterSet(),
        breakdowns: reverse
            ? breakdowns.reverse()
            : breakdowns
    };

    prepareLineFilters(line);
    const settings = line.filters.get('category') as SetAttributeFilter;

    assert.deepEqual(optionKeys(settings).sort(), ['last', 'other', 'script', 'source-only']);

    settings.setSelection('include', ['source-only']);

    assert.deepEqual([...execution.populationViewport.samplesTotal], [10, 0]);
    assert.deepEqual([...other.populationViewport.samplesTotal], [0, 0]);
});
