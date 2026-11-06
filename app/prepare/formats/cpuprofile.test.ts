import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDiagnosticsCollector } from '../diagnostics.js';
import { unwrapSamplesIfNeeded } from './cpuprofile.js';

type CombinedProfile = Parameters<typeof unwrapSamplesIfNeeded>[0];

function allocationKeys(profile: object) {
    return Object.keys(profile).filter(key => key.startsWith('_cpuproAllocation'));
}

// A combined profile wraps CPU samples into `cpuProfile`, allocation rows are aligned by `allocationSamples.ids`
function combinedProfile(allocationSamples: unknown): CombinedProfile {
    return {
        startTime: 0, endTime: 20, samples: [], timeDeltas: [], nodes: [],
        cpuProfile: { samples: [1, 2], timeDeltas: [10, 10], nodes: [] },
        allocationSampleIds: [10, 15],
        allocationSamples
    } as unknown as CombinedProfile;
}

test('typed numeric vectors are adopted without copies', () => {
    const input = {
        startTime: 0, endTime: 20, nodes: [], samples: new Uint32Array([1, 1]), timeDeltas: new Uint32Array([10, 10]),
        allocationSampleIds: new Uint32Array([10, 12]),
        allocationSamples: {
            ids: new Uint32Array([10, 12]), sizes: new Uint32Array([8, 16]),
            gc: new Uint32Array([0, 5]), types: new Uint32Array([1, 1])
        }
    };
    const profile = unwrapSamplesIfNeeded(input as unknown as CombinedProfile);

    assert.equal(profile.samples, input.samples);
    assert.equal(profile.timeDeltas, input.timeDeltas);
    assert.equal(profile._cpuproAllocationIds, input.allocationSamples.ids);
    assert.equal(profile._cpuproAllocationGc, input.allocationSamples.gc);
    assert.equal(profile._cpuproAllocationTypes, input.allocationSamples.types);
});

test.each([
    { allocationSamples: undefined },
    { allocationSamples: {} },
    { allocationSamples: { ids: [10, 15] } },
    { allocationSamples: { sizes: [8, 16] } }
])('keeps the sample mapping without complete allocation rows: %j', ({ allocationSamples }) => {
    const input = combinedProfile(allocationSamples);
    const before = structuredClone(input);
    const profile = unwrapSamplesIfNeeded(input);

    assert.equal(profile.samples, input.cpuProfile!.samples);
    assert.equal(profile.timeDeltas, input.cpuProfile!.timeDeltas);
    assert.equal(profile.nodes, input.cpuProfile!.nodes);
    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.deepEqual(allocationKeys(profile), ['_cpuproAllocationMapping']);
    assert.deepEqual(input, before);
});

test.each([
    { ids: [10, 11, 12], order: 'consecutive' },
    { ids: [10, 12, 15], order: 'ascending' }
])('publishes sorted allocation rows with their $order order', ({ ids, order }) => {
    const allocationSamples = { ids, sizes: [8, 16, 32], types: [1, 2, 3], gc: [0, 1, 2], typesDict: { 1: 'OBJECT' } };
    const input = combinedProfile(allocationSamples);
    const before = structuredClone(input);
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const profile = unwrapSamplesIfNeeded(input, diagnose);

    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.equal(profile._cpuproAllocationIds, ids);
    assert.equal(profile._cpuproAllocationIdsOrder, order);
    assert.equal(profile._cpuproAllocationSizes, allocationSamples.sizes);
    assert.equal(profile._cpuproAllocationTypes, allocationSamples.types);
    assert.equal(profile._cpuproAllocationGc, allocationSamples.gc);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(input, before);
});

test('ignores allocation rows with unsorted IDs and reports it', () => {
    const input = combinedProfile({ ids: [10, 12, 11], sizes: [8, 16, 32], types: [1, 2, 3], gc: [0, 1, 2] });
    const before = structuredClone(input);
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const profile = unwrapSamplesIfNeeded(input, diagnose);

    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.deepEqual(allocationKeys(profile), ['_cpuproAllocationMapping']);
    assert.deepEqual(diagnostics, [
        { level: 'warn', scope: [], message: 'Ignoring allocation data with unsorted IDs' }
    ]);
    assert.deepEqual(input, before);
});
