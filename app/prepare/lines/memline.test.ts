import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { createMemline } from './memline.mjs';
import {
    createMemlineAllocationCodeTypeAttribute,
    createMemlineAllocationTypeAttribute,
    createMemlineGcAttributes
} from './memline-attributes.mjs';
import { createAttributeFilter } from './filters/attribute.js';
import type { ProfileLineAttribute } from './types.js';
import type { V8CpuProfile } from '../types.js';

// Dictionary indices of the values of an attribute, taken through the entries of their codes
function entryValues(attribute: ProfileLineAttribute) {
    return Array.from(attribute.keys, code => attribute.entries[code]);
}

// A memline of allocation data of a profile without CPU samples
async function createAllocationMemline(allocations: Partial<V8CpuProfile>) {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const data = {
        startTime: 0,
        endTime: 0,
        nodes: [],
        samples: [],
        timeDeltas: [],
        ...allocations
    };

    return createMemline(
        data,
        dictionary,
        scriptsMap,
        null,
        null,
        null,
        Promise.resolve()
    );
}

test('keeps allocation locations without borrowing a call stack when CPU samples are absent', async () => {
    const line = await createAllocationMemline({
        _cpuproAllocationMapping: [],
        _cpuproAllocationIds: [1, 2],
        _cpuproAllocationSizes: [16, 32],
        _cpuproAllocationScriptIds: [1, 1],
        _cpuproAllocationLocations: [10, 20]
    });

    assert.ok(line);
    assert.deepEqual(line.breakdowns.map(breakdown => breakdown.kind), ['location']);
    assert.deepEqual([...line.values], [16, 32]);
});

test('maps allocation attribute codes to dictionary indices of 1 byte without changing the input', async () => {
    const sizes = new Uint32Array([16, 32, 48]);
    const types = new Uint32Array([7, 7, 9]);
    const spaces = new Uint32Array([2, 4, 2]);
    // GC value is epoch << 2 | lifespan, lifespans 2, 0, 1 differ from the epoch indices
    const gc = new Uint32Array([0 << 2 | 2, 1 << 2 | 0, 2 << 2 | 1]);
    const line = await createAllocationMemline({
        _cpuproAllocationSizes: sizes,
        _cpuproAllocationGc: gc,
        _cpuproAllocationTypes: types,
        _cpuproAllocationTypeNames: { 7: 'FIRST_TYPE', 9: 'SECOND_TYPE' },
        _cpuproAllocationSpaces: spaces,
        _cpuproAllocationSpaceNames: { 2: 'new_space', 4: 'old_space' }
    });
    const attribute = (name: string) => line!.attributes.find(entry => entry.name === name)!;

    assert.equal(line!.values.buffer, sizes.buffer);
    assert.deepEqual(attribute('allocationType').keys, new Uint8Array([0, 0, 1]));
    assert.deepEqual(attribute('allocationSpace').keys, new Uint8Array([0, 1, 0]));
    assert.deepEqual(attribute('allocationGcEpoch').keys, new Uint8Array([0, 1, 2]));
    assert.equal(attribute('allocationLifespan').keys, attribute('allocationGcEpoch').keys);
    assert.deepEqual(entryValues(attribute('allocationLifespan')), [2, 0, 1]);
    // Queries read the dictionary indices of events, materialized from the keys
    assert.deepEqual(attribute('allocationLifespan').values, new Uint8Array([2, 0, 1]));
    assert.deepEqual([...types], [7, 7, 9]);
    assert.deepEqual([...spaces], [2, 4, 2]);
    assert.deepEqual([...gc], [0 << 2 | 2, 1 << 2 | 0, 2 << 2 | 1]);
});

// Context info holds a VM state in bits 0-3 and a builtin (its id + 1) in bits 4-31: JS code (0), the VM state
// OTHER (5), a builtin in JS, and a builtin under which the bytecode compiler (3) allocates
test.each([
    {
        name: 'take the types of their contexts outside JS code, a VM state over a builtin',
        contextInfo: Uint32Array.of(0, 0x05, 0x10, 0x13),
        values: [0, 4, 3, 4],
        dict: ['Ignition', 'Turbofan', 'Sparkplug', 'Builtin', 'Other']
    },
    {
        name: 'keep their code types without context info',
        contextInfo: null,
        values: [0, 1, 2, 1],
        dict: ['Ignition', 'Turbofan', 'Sparkplug']
    }
])('code types of allocations $name', row => {
    const attribute = createMemlineAllocationCodeTypeAttribute(
        Uint32Array.of(0, 1, 2, 1),
        { 0: 'ignition', 1: 'turbofan', 2: 'baseline' },
        row.contextInfo
    );

    assert.deepEqual(attribute!.keys, Uint8Array.from(row.values));
    assert.deepEqual(attribute!.dict, row.dict);
});

test('code types of allocations take the types of their contexts for context info of any magnitude', () => {
    // JS code for the first 2^16 allocations, then builtins and builtins under the VM state OTHER of growing ids,
    // up to ids far beyond the builtins of V8
    const contexts = [
        [0x10, 3],
        [0x15, 4],
        [0xfff0, 3],
        [0xfff5, 4],
        [0x80000000, 3],
        [0x80000005, 4]
    ];
    const count = 0x10000 + 1000;
    const codeTypes = new Uint32Array(count);
    const contextInfo = new Uint32Array(count);
    const expected = new Uint8Array(count);

    for (let i = 0; i < count; i++) {
        codeTypes[i] = i % 3;

        if (i < 0x10000) {
            expected[i] = i % 3;
        } else {
            [contextInfo[i], expected[i]] = contexts[i % contexts.length];
        }
    }

    const attribute = createMemlineAllocationCodeTypeAttribute(
        codeTypes,
        { 0: 'ignition', 1: 'turbofan', 2: 'baseline' },
        contextInfo
    );

    assert.deepEqual(attribute!.keys, expected);
});

test('classes of allocations keep one lifespan implied by GC epochs from lists of traces', async () => {
    // GC values of one collection number with different lifespans, and allocations of no list (alive)
    const line = await createAllocationMemline({
        _cpuproAllocationIds: [1, 2, 3, 4, 5, 6],
        _cpuproAllocationIdsOrder: 'consecutive',
        _cpuproAllocationSizes: new Uint32Array([16, 16, 16, 16, 16, 16]),
        _cpuproAllocationGcIds: [
            {
                [1 << 2 | 1]: new Uint32Array([1, 4])
            },
            {
                [1 << 2 | 2]: new Uint32Array([2]),
                [2 << 2 | 1]: new Uint32Array([5])
            }
        ]
    });
    const { ids, events, values } = line!.eventClasses;
    const lifespan = line!.attributes.find(attribute => attribute.name === 'allocationLifespan')!;
    const lifespans = entryValues(lifespan);

    assert.ok(values.has(lifespan.keys));
    assert.deepEqual(lifespans, [1, 2, 0, 1, 1, 0]);
    assert.deepEqual([...ids].map(id => lifespans[events[id]]), [...lifespans]);
    assert.equal(events.length, 4);
});

test('maps attribute codes to 4-byte indices when a dictionary exceeds 256 entries', () => {
    const typeNames: Record<number, string> = {};

    for (let i = 0; i < 300; i++) {
        typeNames[i] = `TYPE_${i}`;
    }

    const attribute = createMemlineAllocationTypeAttribute(new Uint32Array([0, 299]), typeNames)!;

    assert.deepEqual(attribute.keys, new Uint32Array([0, 299]));
});

test.each([
    {
        name: 'beyond the named ones',
        names: { 7: 'FIRST_TYPE', 9: 'SECOND_TYPE' },
        values: [0, 0]
    },
    {
        name: 'without names',
        names: null,
        values: [0, 0]
    }
])('maps type codes $name to dictionary index 0', row => {
    const attribute = createMemlineAllocationTypeAttribute(new Uint32Array([10, 1000]), row.names)!;

    assert.deepEqual([...attribute.keys], row.values);
});

// A GC value is the collection number << 2 | lifespan, 0 is an allocation of no collection
test.each([
    {
        name: 'with allocations of no collection',
        gc: [0, 2345678 << 2 | 1, 0, 2345680 << 2 | 2],
        values: [0, 1, 0, 3],
        dict: [['none', 0], ['minor', 2345678], ['unknown', 2345679], ['major', 2345680]]
    },
    {
        name: 'without allocations of no collection',
        gc: [2345679 << 2 | 2, 2345678 << 2 | 1],
        values: [1, 0],
        dict: [['minor', 2345678], ['major', 2345679]]
    }
])('maps GC values of large collection numbers $name to dictionary indices', row => {
    const [, epochs] = createMemlineGcAttributes(Uint32Array.from(row.gc), null, null, null);

    assert.ok(epochs !== undefined);

    assert.deepEqual([...epochs.keys], row.values);
    assert.deepEqual(epochs.dict.map(entry => [entry.type, entry.epoch]), row.dict);
});

test('decodes unsigned GC values without losing the high bit', () => {
    const gc = new Uint32Array([0x80000001]);
    const [lifespan, epochs] = createMemlineGcAttributes(gc, null, null, null);

    assert.ok(lifespan !== undefined && epochs !== undefined);
    assert.deepEqual(entryValues(lifespan), [1]);
    assert.deepEqual([...epochs.keys], [0]);
    assert.equal(epochs.dict[0].epoch, 0x20000000);
    assert.equal(epochs.dict[0].type, 'minor');
});

test('a lifespan filter accepts the GC epochs of the lifespans it takes', () => {
    // Allocations of no collection, of minor collections 1 and 3 and of a major collection 2
    const [lifespan] = createMemlineGcAttributes(Uint32Array.of(0, 1 << 2 | 1, 2 << 2 | 2, 3 << 2 | 1), null, null, null);
    const filter = createAttributeFilter(lifespan!, 4)!;

    filter.settings.setSelection('include', ['short-lived']);

    assert.deepEqual([...lifespan!.keys], [0, 1, 2, 3]);
    assert.deepEqual([...filter.compile(filter.settings)], [0, 1, 0, 1]);
});
