import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { noopWorkHandler } from '../misc/work.js';
import { createMemline } from './memline.mjs';
import {
    createMemlineAllocationLifespanAttribute,
    createMemlineAllocationTypeAttribute,
    createMemlineGcEpochAttribute
} from './memline-attributes.mjs';

const noCpuSamples = { startTime: 0, endTime: 0, nodes: [], samples: [], timeDeltas: [] };

test('keeps allocation locations without borrowing a call stack when CPU samples are absent', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const line = await createMemline({
        ...noCpuSamples,
        _cpuproAllocationMapping: [],
        _cpuproAllocationIds: [1, 2],
        _cpuproAllocationSizes: [16, 32],
        _cpuproAllocationScriptIds: [1, 1],
        _cpuproAllocationLocations: [10, 20]
    }, dictionary, scriptsMap, null, null, null, Promise.resolve(), { work: noopWorkHandler });

    assert.ok(line);
    assert.deepEqual(line.breakdowns.map(breakdown => breakdown.kind), ['location']);
    assert.deepEqual([...line.values], [16, 32]);
});

test('maps allocation attribute codes to dictionary indices of 1 byte without changing the input', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const sizes = new Uint32Array([16, 32, 48]);
    const types = new Uint32Array([7, 7, 9]);
    const spaces = new Uint32Array([2, 4, 2]);
    // GC value is epoch << 2 | lifespan, lifespans 2, 0, 1 differ from the epoch indices
    const gc = new Uint32Array([0 << 2 | 2, 1 << 2 | 0, 2 << 2 | 1]);
    const line = await createMemline({
        ...noCpuSamples,
        _cpuproAllocationSizes: sizes,
        _cpuproAllocationGc: gc,
        _cpuproAllocationTypes: types,
        _cpuproAllocationTypeNames: { 7: 'FIRST_TYPE', 9: 'SECOND_TYPE' },
        _cpuproAllocationSpaces: spaces,
        _cpuproAllocationSpaceNames: { 2: 'new_space', 4: 'old_space' }
    }, dictionary, scriptsMap, null, null, null, Promise.resolve());
    const attribute = (name: string) => line!.attributes.find(attribute => attribute.name === name)!;

    assert.equal(line!.values.buffer, sizes.buffer);
    assert.deepEqual(attribute('allocationType').values, new Uint8Array([0, 0, 1]));
    assert.deepEqual(attribute('allocationSpace').values, new Uint8Array([0, 1, 0]));
    assert.deepEqual(attribute('allocationGcEpoch').values, new Uint8Array([0, 1, 2]));
    assert.deepEqual(attribute('allocationLifespan').values, new Uint8Array([2, 0, 1]));
    assert.deepEqual([...types], [7, 7, 9]);
    assert.deepEqual([...spaces], [2, 4, 2]);
    assert.deepEqual([...gc], [0 << 2 | 2, 1 << 2 | 0, 2 << 2 | 1]);
});

test('maps attribute codes to 4-byte indices when a dictionary exceeds 256 entries', () => {
    const typeNames: Record<number, string> = {};

    for (let i = 0; i < 300; i++) {
        typeNames[i] = `TYPE_${i}`;
    }

    const attribute = createMemlineAllocationTypeAttribute(new Uint32Array([0, 299]), typeNames)!;

    assert.deepEqual(attribute.values, new Uint32Array([0, 299]));
});

test('decodes unsigned GC values without losing the high bit', () => {
    const gc = new Uint32Array([0x80000001]);
    const lifespan = createMemlineAllocationLifespanAttribute(gc)!;
    const epochs = createMemlineGcEpochAttribute(gc)!;

    assert.deepEqual([...lifespan.values], [1]);
    assert.deepEqual([...epochs.values], [0]);
    assert.equal(epochs.dict[0].epoch, 0x20000000);
    assert.equal(epochs.dict[0].type, 'minor');
});
