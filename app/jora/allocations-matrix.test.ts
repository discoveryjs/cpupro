import assert from 'node:assert/strict';
import { test } from 'vitest';
import { methods } from './index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import type { ProfileLineAllocationOwnerAttribute, ProfileLineAllocationCompilationStageAttribute } from '../prepare/lines/types.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';

test.each([{ mapping: [1, 3, 4] }, { mapping: [0, 4, 4] }, { mapping: [4, 4, 4] }])('excludes sink at the end of or inside a tree mapping: $mapping', async ({ mapping }) => {
    const { profile } = await createProfileFixture({ mapping });
    const line = profile.memline!;
    const breakdown = line.breakdowns.find(entry => entry.kind === 'call-stack')!;
    line.attributes.push(
        { name: 'allocationType', values: new Uint32Array([0, 0, 0, 0]), dict: ['object'] },
        { name: 'allocationLifespan', values: new Uint8Array([0, 0, 0, 0]), dict: ['alive'] }
    );
    const population = breakdown.populationFiltered;
    const matrix = () => methods.allocationsMatrix.call(
        { context: {} }, breakdown.callFrames!.filtered.nodes, population, () => true, profile
    );
    assert.equal(matrix()[0].total.sum, 160);
    population.updateMask(mask => {
        mask[0] = 0x80000000;
    });
    const accepted = population.population.values.reduce((sum, value, index) =>
        sum + (population.population.samples[index] === 0 ? 0 : value), 0
    );
    assert.equal(matrix()[0]?.total.sum ?? 0, accepted);
    population.updateMask(mask => mask.fill(0x80000000));
    assert.deepEqual(matrix(), []);
    assert.equal(population.sink.total, 160);
    population.resetMask();
    assert.equal(matrix()[0].total.sum, 160);
});

test('selects compilation owners and stages without losing allocation filters', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline!;
    const population = line.breakdowns.find(entry => entry.kind === 'location')!.populationFiltered;
    const attribute: ProfileLineAllocationOwnerAttribute = {
        name: 'allocationOwner', dict: [null, { scriptId: 1, start: 0 }, { scriptId: 1, start: 20 }], values: new Uint32Array([1, 2, 1, 0])
    };
    const stages: ProfileLineAllocationCompilationStageAttribute = {
        name: 'allocationCompilationStage', dict: ['none', 'Stage1', 'Stage2'], values: new Uint8Array([1, 1, 2, 0])
    };
    line.attributes.push(
        attribute, stages,
        { name: 'allocationType', values: new Uint32Array([0, 1, 0, 1]), dict: ['BYTECODE_ARRAY', 'FIXED_ARRAY'] },
        { name: 'allocationLifespan', values: new Uint8Array([0, 1, 2, 0]), dict: ['alive', 'short-lived', 'long-lived'] }
    );
    const matrix = () => methods.allocationsMatrix.call(
        { context: {} }, attribute, population, attribute.dict[1], profile
    );
    const stopFilters = prepareLineFilters(line);
    const stageFilter = line.filters.get('allocationCompilationStage') as SetAttributeFilter;

    const [row] = matrix();
    assert.equal(row.type, 'BYTECODE_ARRAY');
    assert.deepEqual(row.total, { count: 2, sum: 64, min: 16, max: 48 });
    assert.equal(row.alive.sum, 16);
    assert.equal(row['long-lived'].sum, 48);
    stageFilter.setSelection('include', ['Stage1']);
    assert.equal(matrix()[0].total.sum, 16);
    stageFilter.setSelection('include', ['Stage2']);
    assert.equal(matrix()[0].total.sum, 48);
    stageFilter.allowAll();

    population.setIndexRange(1, 3);
    assert.deepEqual(matrix()[0].total, { count: 1, sum: 48, min: 48, max: 48 });
    population.resetIndexRange();
    population.updateMask(mask => mask.fill(0x80000000));
    assert.deepEqual(matrix(), []);
    population.resetMask();
    assert.equal(matrix()[0].total.sum, 64);
    const all = methods.allocationsMatrix.call({ context: {} }, attribute, population, (owner: unknown) => owner !== null, profile);
    assert.equal(all.reduce((sum, entry) => sum + entry.total.sum, 0), 96);
    stopFilters();
});

test('attribute sample totals honor ranges and stage filters without partial-object double counting', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const population = profile.memline!.breakdowns[0].populationFiltered;
    const owners: ProfileLineAllocationOwnerAttribute = {
        name: 'allocationOwner', dict: [null, { scriptId: 1, start: 0 }, { scriptId: 1, start: 20 }], values: new Uint32Array([1, 2, 1, 0])
    };
    const totals = () => methods.attributeSampleTotals(owners, population);
    assert.deepEqual(totals().map(row => [row.count, row.size]), [[1, 64], [2, 64], [1, 32]]);
    population.setRanges([{ start: 5, end: 10 }]);
    assert.deepEqual(totals()[1], { entry: owners.dict[1], count: 1, size: 5 });
    population.setRanges([{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 20, end: 24 }]);
    assert.deepEqual(totals().map(row => [row.count, row.size]), [[0, 0], [1, 4], [1, 4]]);
    population.updateMask(mask => mask.fill(0x80000000));
    assert.ok(totals().every(row => row.count === 0 && row.size === 0));
});
