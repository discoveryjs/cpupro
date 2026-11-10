import assert from 'node:assert/strict';
import { test } from 'vitest';
import { methods } from './index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import type { ProfileLineAllocationOwnerAttribute, ProfileLineAllocationCompilationStageAttribute } from '../prepare/lines/types.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';

// Fixture allocation events weigh 16, 32, 48 and 64 bytes
function addTypesAndLifespans(profile: Awaited<ReturnType<typeof createProfileFixture>>['profile'], types: number[], lifespans: number[]) {
    profile.memline!.attributes.push(
        { name: 'allocationType', values: Uint32Array.from(types), dict: ['object', 'array'] },
        { name: 'allocationLifespan', values: Uint8Array.from(lifespans), dict: ['alive', 'short-lived'] }
    );
}

test.each([
    { mapping: [1, 3, 4], samples: 'events 0 and 3 in sample 0', masked: [80] },
    { mapping: [0, 4, 4], samples: 'no event in sample 0', masked: [160] },
    { mapping: [4, 4, 4], samples: 'every event in sample 0', masked: [] }
])('rows count only events outside sink: $samples', async ({ mapping, masked }) => {
    const { profile } = await createProfileFixture({ mapping });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;
    const population = breakdown.populationFiltered;
    const sums = () => methods.allocationsMatrix
        .call({ context: {} }, breakdown.callFrames!.filtered.nodes, population, () => true, profile)
        .map(row => row.total.sum);

    addTypesAndLifespans(profile, [0, 0, 0, 0], [0, 0, 0, 0]);
    assert.deepEqual(sums(), [160]);

    const sampleCount = population.samplesMask.length;
    const firstRejected = new Uint8Array(sampleCount).fill(1);
    const setSampleFilter = (accepts: Uint8Array) => population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: sampleCount,
        accepts
    });

    firstRejected[0] = 0;
    setSampleFilter(firstRejected);
    assert.deepEqual(sums(), masked);

    setSampleFilter(new Uint8Array(sampleCount));
    assert.deepEqual(sums(), []);

    population.filter.remove('samples');
    assert.deepEqual(sums(), [160]);
});

test('rows summarize each type by lifespan, cells with several events keep their extremes', async () => {
    const { profile } = await createProfileFixture({ mapping: [0, 4, 4] });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;

    // Objects: 16 and 48 bytes alive, 32 short-lived; arrays: 64 bytes alive
    addTypesAndLifespans(profile, [0, 0, 0, 1], [0, 1, 0, 0]);
    const population = breakdown.populationFiltered;
    const rows = () => methods.allocationsMatrix.call(
        { context: {} }, breakdown.callFrames!.filtered.nodes, population, () => true, profile
    );

    assert.deepEqual(rows(), [
        {
            type: 'object',
            total: { count: 3, sum: 96, min: 16, max: 48 },
            alive: { count: 2, sum: 64, min: 16, max: 48 },
            'short-lived': { count: 1, sum: 32, min: 32, max: 32 }
        },
        {
            type: 'array',
            total: { count: 1, sum: 64, min: 64, max: 64 },
            alive: { count: 1, sum: 64, min: 64, max: 64 },
            'short-lived': { count: 0, sum: 0, min: 0, max: 0 }
        }
    ]);

    // The range cuts the 48-byte object at 60 bytes to 12 bytes, below the other alive object
    population.setRange(0, 60);
    assert.deepEqual(rows()[0].alive, { count: 2, sum: 28, min: 12, max: 16 });
});

test.each([
    { missing: 'allocationType' },
    { missing: 'allocationLifespan' }
])('there is no matrix without $missing', async ({ missing }) => {
    const { profile } = await createProfileFixture({ mapping: [0, 4, 4] });
    const breakdown = profile.memline!.breakdowns.find(entry => entry.kind === 'call-stack')!;

    addTypesAndLifespans(profile, [0, 0, 0, 1], [0, 1, 0, 0]);
    profile.memline!.attributes = profile.memline!.attributes.filter(attribute => attribute.name !== missing);

    assert.deepEqual(methods.allocationsMatrix.call(
        { context: {} }, breakdown.callFrames!.filtered.nodes, breakdown.populationFiltered, () => true, profile
    ), []);
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

    population.setRanges([{ start: 5, end: 6 }]);
    assert.deepEqual(matrix()[0].total, { count: 1, sum: 1, min: 1, max: 1 });
    population.setRanges([{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 50, end: 55 }]);
    assert.deepEqual(matrix()[0].total, { count: 2, sum: 9, min: 4, max: 5 });
    assert.equal(matrix()[0].total.sum, methods.attributeSampleTotals(attribute, population)[1].size);
    stageFilter.setSelection('include', ['Stage2']);
    assert.deepEqual(matrix()[0].total, { count: 1, sum: 5, min: 5, max: 5 });
    stageFilter.allowAll();
    population.setRanges([{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }]);
    assert.deepEqual(matrix()[0].total, { count: 1, sum: 1, min: 1, max: 1 });
    population.setRanges([{ start: 0.1, end: 0.7 }]);
    assert.deepEqual(matrix(), []);
    population.resetRange();

    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: population.samplesMask.length,
        accepts: new Uint8Array(population.samplesMask.length)
    });
    assert.deepEqual(matrix(), []);
    population.filter.remove('samples');
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
    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: population.samplesMask.length,
        accepts: new Uint8Array(population.samplesMask.length)
    });
    assert.ok(totals().every(row => row.count === 0 && row.size === 0));
});
