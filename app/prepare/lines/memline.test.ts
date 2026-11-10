import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { noopWorkHandler } from '../misc/work.js';
import { createVectorLocations } from '../preprocessing/locations.js';
import { createMemline } from './memline.mjs';
import { createMemlineAllocationLifespanAttribute, createMemlineGcEpochAttribute } from './memline-attributes.mjs';

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

test('remaps allocation attribute codes in place, reading lifespan before GC epochs', async () => {
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
    assert.equal(attribute('allocationType').values, types);
    assert.equal(attribute('allocationSpace').values, spaces);
    assert.equal(attribute('allocationGcEpoch').values, gc);
    assert.deepEqual([...types], [0, 0, 1]);
    assert.deepEqual([...spaces], [0, 1, 0]);
    assert.deepEqual([...gc], [0, 1, 2]);
    assert.deepEqual([...attribute('allocationLifespan').values], [2, 0, 1]);
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

test('decodes unsigned builtin IDs from allocation context info', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const resolve = vi.spyOn(dictionary, 'resolveCallFrame');

    try {
        createVectorLocations(
            dictionary, scriptsMap, new Int32Array([0]), new Int32Array([-1]),
            new Uint32Array([0x80000000]), null, null
        );
        const names = resolve.mock.calls.map(([frame]) => frame.functionName);

        assert.ok(names.includes('(builtin) unknown-builtin[134217728]'));
    } finally {
        resolve.mockRestore();
    }
});
