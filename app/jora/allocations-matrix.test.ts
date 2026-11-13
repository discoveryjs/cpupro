import assert from 'node:assert/strict';
import { test } from 'vitest';
import { methods } from './index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { dictEntries, findBreakdown } from '../../test/fixtures/lines.js';
import type {
    ProfileLine,
    ProfileLineAllocationOwnerAttribute,
    ProfileLineAllocationCompilationStageAttribute
} from '../prepare/lines/types.js';
import type { PopulationFiltered } from '../prepare/computations/population.js';
import type { Profile } from '../prepare/profile.mjs';
import { prepareLineFilters } from '../prepare/lines/filters.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';

// The fixture's allocation events weigh 16, 32, 48 and 64 bytes and take 0–16, 16–48, 48–96 and 96–160 bytes of
// the line; samples of its call-stack population are CPU samples of 2 call stacks

// Objects of 16 and 48 bytes are alive, of 32 bytes short-lived; the array of 64 bytes is alive; no strings
function addAllocationKinds(line: ProfileLine) {
    line.attributes.push(
        {
            name: 'allocationType',
            keys: Uint32Array.from([0, 0, 0, 1]),
            entries: dictEntries(['object', 'array', 'string']),
            dict: ['object', 'array', 'string']
        },
        {
            name: 'allocationLifespan',
            keys: Uint8Array.from([0, 1, 0, 0]),
            entries: dictEntries(['alive', 'short-lived']),
            dict: ['alive', 'short-lived']
        }
    );
}

// A matrix of the memline call-stack nodes, accepting all of them
async function createNodesMatrix(mapping: number[]) {
    const { profile } = await createProfileFixture({ mapping });
    const line = profile.memline!;
    const breakdown = findBreakdown(line, 'call-stack');
    const nodes = breakdown.callFrames!.filtered.nodes;
    const population = breakdown.populationFiltered;
    const matrix = () => methods.allocationsMatrix.call(
        { context: {} },
        nodes,
        population,
        () => true,
        profile
    );

    addAllocationKinds(line);

    return {
        profile,
        line,
        nodes,
        population,
        matrix
    };
}

// Owners of the allocation events: the first and the third are of a function, the second of another one, the last
// has no owner
function createOwners(): ProfileLineAllocationOwnerAttribute {
    return {
        name: 'allocationOwner',
        dict: [null, { scriptId: 1, start: 0 }, { scriptId: 1, start: 20 }],
        entries: dictEntries([null, null, null]),
        keys: new Uint32Array([1, 2, 1, 0])
    };
}

// Rejects the samples of a call-stack population whose CPU samples are of the rejected call stacks
function rejectStacks(profile: Profile, population: PopulationFiltered, rejected: number[]) {
    const cpuSamples = profile.timeline!.breakdowns[0].population.samples;
    const rejectedStacks = new Set(rejected);
    const accepts = new Uint8Array(population.samplesMask.length);

    for (let i = 0; i < accepts.length; i++) {
        if (!rejectedStacks.has(cpuSamples[i])) {
            accepts[i] = 1;
        }
    }

    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: accepts.length,
        accepts
    });
}

test('a row of each type with allocations has a cell of every lifespan and their total', async () => {
    const { matrix } = await createNodesMatrix([0, 4, 4]);

    assert.deepEqual(matrix(), [
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
});

test.each([
    { missing: 'allocationType' },
    { missing: 'allocationLifespan' }
])('there is no matrix without $missing', async row => {
    const { line, matrix } = await createNodesMatrix([0, 4, 4]);

    line.attributes = line.attributes.filter(attribute => attribute.name !== row.missing);

    assert.deepEqual(matrix(), []);
});

test('without a profile the matrix is of the scope profile', async () => {
    const { profile, nodes, population } = await createNodesMatrix([0, 4, 4]);
    const context = { scopeProfile: profile };
    const rows = methods.allocationsMatrix.call({ context }, nodes, population, () => true, undefined);

    assert.deepEqual(rows.map(row => row.total.sum), [96, 64]);
});

test.each([
    {
        name: 'events 0 and 3 in sample 0',
        mapping: [1, 3, 4],
        rejected: [0],
        sums: [80]
    },
    {
        name: 'no event in sample 0',
        mapping: [0, 4, 4],
        rejected: [0],
        sums: [96, 64]
    },
    {
        name: 'every event in sample 0',
        mapping: [4, 4, 4],
        rejected: [0],
        sums: []
    },
    {
        name: 'every sample rejected',
        mapping: [0, 4, 4],
        rejected: [0, 1],
        sums: []
    }
])('events of samples of rejected call stacks are not counted: $name', async row => {
    const { profile, population, matrix } = await createNodesMatrix(row.mapping);

    rejectStacks(profile, population, row.rejected);

    assert.deepEqual(matrix().map(entry => entry.total.sum), row.sums);
});

test.each([
    {
        name: 'cuts an event to its part in the range',
        ranges: [{ start: 0, end: 60 }],
        alive: { count: 2, sum: 28, min: 12, max: 16 }
    },
    {
        name: 'counts an event cut by ranges once',
        ranges: [{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 50, end: 55 }],
        alive: { count: 2, sum: 9, min: 4, max: 5 }
    },
    {
        name: 'omits an event outside the ranges',
        ranges: [{ start: 20, end: 30 }],
        alive: { count: 0, sum: 0, min: 0, max: 0 }
    },
    {
        name: 'cuts an event of another type',
        ranges: [{ start: 100, end: 110 }],
        alive: { count: 1, sum: 10, min: 10, max: 10 }
    }
])('a range selection $name', async row => {
    const { population, matrix } = await createNodesMatrix([0, 4, 4]);

    population.setRanges(row.ranges);

    assert.deepEqual(matrix()[0].alive, row.alive);
});

// An owner attribute as the source, as the compilations page selects allocations of a function
async function createOwnerMatrix() {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline!;
    const population = findBreakdown(line, 'location').populationFiltered;
    const owners = createOwners();
    const stages: ProfileLineAllocationCompilationStageAttribute = {
        name: 'allocationCompilationStage',
        dict: ['none', 'Stage1', 'Stage2'],
        entries: dictEntries(['none', 'Stage1', 'Stage2']),
        keys: new Uint8Array([1, 1, 2, 0])
    };

    addAllocationKinds(line);
    line.attributes.push(owners, stages);

    const matrix = (accepts: unknown) => methods.allocationsMatrix.call(
        { context: {} },
        owners,
        population,
        accepts,
        profile
    );

    return { line, population, owners, matrix };
}

test('an attribute source counts the events of its entries accepted by the test', async () => {
    const { owners, matrix } = await createOwnerMatrix();
    const all = matrix((owner: unknown) => owner !== null);

    assert.deepEqual(matrix(owners.dict[1]), [
        {
            type: 'object',
            total: { count: 2, sum: 64, min: 16, max: 48 },
            alive: { count: 2, sum: 64, min: 16, max: 48 },
            'short-lived': { count: 0, sum: 0, min: 0, max: 0 }
        }
    ]);
    assert.deepEqual(all.map(row => row.total.sum), [96]);
    assert.deepEqual(matrix(() => false), []);
});

test.each([
    {
        name: 'a stage',
        stages: ['Stage2'],
        ranges: null,
        totals: [{ count: 1, sum: 48, min: 48, max: 48 }]
    },
    {
        name: 'parts of events in ranges',
        stages: ['Stage1', 'Stage2'],
        ranges: [{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 50, end: 55 }],
        totals: [{ count: 2, sum: 9, min: 4, max: 5 }]
    },
    {
        name: 'a stage and parts of events in ranges',
        stages: ['Stage2'],
        ranges: [{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 50, end: 55 }],
        totals: [{ count: 1, sum: 5, min: 5, max: 5 }]
    },
    {
        name: 'fractional parts summing to a byte',
        stages: ['Stage1', 'Stage2'],
        ranges: [{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }],
        totals: [{ count: 1, sum: 1, min: 1, max: 1 }]
    },
    {
        name: 'a fractional part below a byte',
        stages: ['Stage1', 'Stage2'],
        ranges: [{ start: 0.1, end: 0.7 }],
        totals: []
    }
])('an attribute source keeps the allocation filters: $name', async row => {
    const { line, population, owners, matrix } = await createOwnerMatrix();
    const stopFilters = prepareLineFilters(line);
    const stageFilter = line.filters.get('allocationCompilationStage') as SetAttributeFilter;

    stageFilter.setSelection('include', row.stages);
    population.setRanges(row.ranges);

    assert.deepEqual(matrix(owners.dict[1]).map(entry => entry.total), row.totals);
    stopFilters();
});

test.each([
    {
        name: 'the whole line',
        ranges: null,
        totals: [[1, 64], [2, 64], [1, 32]]
    },
    {
        name: 'a part of an event',
        ranges: [{ start: 5, end: 10 }],
        totals: [[0, 0], [1, 5], [0, 0]]
    },
    {
        name: 'parts of events in several ranges',
        ranges: [{ start: 1, end: 3 }, { start: 8, end: 10 }, { start: 20, end: 24 }],
        totals: [[0, 0], [1, 4], [1, 4]]
    }
])('attribute sample totals count events and their bytes in $name', async row => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const population = profile.memline!.breakdowns[0].populationFiltered;
    const owners = createOwners();

    population.setRanges(row.ranges);
    const totals = methods.attributeSampleTotals(owners, population);

    assert.deepEqual(totals.map(entry => [entry.count, entry.size]), row.totals);
    assert.equal(totals[1].entry, owners.dict[1]);
});

test('attribute sample totals are zero when every call stack is rejected', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const population = profile.memline!.breakdowns[0].populationFiltered;
    const totals = () => methods.attributeSampleTotals(createOwners(), population);

    rejectStacks(profile, population, [0, 1]);

    assert.deepEqual(totals().map(entry => [entry.count, entry.size]), [[0, 0], [0, 0], [0, 0]]);
});
