import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../../test/fixtures/profile.js';
import { Population, PopulationFiltered } from '../../computations/population.js';
import { FilterSet } from '../../computations/filter-set.js';
import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import { prepareLineFilters } from '../filters.js';
import { createCategoryFilter } from './category.js';

test('unions categories per population and line without depending on breakdown kind or order', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const original = profile.timeline!.breakdowns[0];
    const entry = original.source.dictionary[0];
    const callFrame = 'callFrame' in entry ? entry.callFrame : entry;
    const makeSource = (names: string[]) => ({
        dictionary: names.map((name, index) => ({ ...callFrame, category: { id: index, name } })),
        parent: new Uint32Array([0, 0]),
        nodes: new Uint32Array([0, 1]),
        sourceIdToNode: new Int32Array([0, 1])
    });

    for (const reverse of [false, true]) {
        const first = new PopulationFiltered(new Population(new Uint32Array([0, 1]), new Uint32Array([10, 20])));
        const second = new PopulationFiltered(new Population(new Uint32Array([0, 1]), new Uint32Array([30, 40])));
        const execution = { ...original, kind: 'first-view', population: first.population, populationFiltered: first, source: makeSource(['script', 'script']) };
        const mapped = { ...execution, kind: 'another-view', source: makeSource(['source-only', 'script']) };
        const other = { ...original, population: second.population, populationFiltered: second, source: makeSource(['other', 'other']) };
        const local = createCategoryFilter([execution, mapped]);
        assert.deepEqual(local.settings.options.map(option => option.key), ['script', 'source-only']);
        assert.deepEqual(createCategoryFilter([other]).settings.options.map(option => option.key), ['other']);
        const breakdowns = [execution, mapped, other];
        const line = { ...profile.timeline!, filters: new FilterSet(), breakdowns: reverse ? breakdowns.reverse() : breakdowns };
        const stop = prepareLineFilters(line);
        assert.deepEqual(line.filters.filters.map(filter => filter.key), ['category']);
        const settings = line.filters.get('category') as SetAttributeFilter;
        assert.deepEqual(settings.options.map(option => option.key).sort(), ['other', 'script', 'source-only']);
        assert.equal(first.filter.filters.length, 1);
        assert.equal(second.filter.filters.length, 1);
        let updates = 0;
        first.subscribe(() => updates++);
        settings.setSelection('include', ['source-only']);
        assert.equal(updates, 1);
        assert.deepEqual([...first.samplesTotal], [10, 0]);
        assert.deepEqual([...second.samplesTotal], [0, 0]);
        const prepared = first.filter.get('category')!;
        settings.setSelection('exclude', ['source-only']);
        assert.deepEqual([...first.samplesTotal], [0, 20]);
        assert.deepEqual([...second.samplesTotal], [30, 40]);
        assert.deepEqual([0, 1].map(prepared.accepts!), [true, false]);
        settings.setSelection('include', ['script']);
        assert.deepEqual([...first.samplesTotal], [10, 20]);
        settings.setSelection('exclude', ['script']);
        assert.deepEqual([...first.samplesTotal], [0, 0]);
        settings.setSelection('include', []);
        assert.deepEqual([...first.samplesTotal], [0, 0]);
        settings.allowAll();
        assert.deepEqual(first.samplesTotal, first.population.samplesTotal);
        assert.deepEqual(second.samplesTotal, second.population.samplesTotal);
        stop();
    }
});
