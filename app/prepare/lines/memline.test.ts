import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { Dictionary } from '../dictionary.js';
import { OriginalScriptsMap, ProfileScriptsMap } from '../preprocessing/scripts.js';
import { noopWorkHandler } from '../misc/work.js';
import { createMemline } from './memline.mjs';
import { createVectorLocations } from '../preprocessing/locations.js';
import {
    createMemlineAllocationOwnerAttribute,
    createMemlineAllocationCompilationStageAttribute,
    createMemlineAllocationLifespanAttribute,
    createMemlineGcEpochAttribute
} from './memline-attributes.mjs';
import type { UniformCompilationRecord } from '../formats/types.js';
import { prepareCompilationRecords } from '../preprocessing/compilation-events.js';

test('keeps allocation locations without creating a borrowed call stack when CPU samples are absent', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const line = await createMemline({
        startTime: 0,
        endTime: 0,
        nodes: [],
        samples: [],
        timeDeltas: [],
        _cpuproAllocationMapping: [],
        _cpuproAllocationIds: [1, 2],
        _cpuproAllocationSizes: [16, 32],
        _cpuproAllocationScriptIds: [1, 1],
        _cpuproAllocationLocations: [10, 20]
    }, dictionary, scriptsMap, null, null, Promise.resolve(), { work: noopWorkHandler });

    assert.ok(line);
    assert.deepEqual(line.breakdowns.map(breakdown => breakdown.kind), ['location']);
    assert.deepEqual([...line.values], [16, 32]);
    assert.equal(line.breakdowns[0].population.values, line.values);
});

test('compilation owner and stage use independent attribute dictionaries', () => {
    const dictionary = new Dictionary();
    const scriptsMap = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 1, url: 'fixture.js', source: '' }]);
    const first = dictionary.resolveCallFrame({
        scriptId: 1, url: 'fixture.js', functionName: 'first', lineNumber: 0, columnNumber: 10, start: 10, end: 19
    }, scriptsMap);
    const second = dictionary.resolveCallFrame({
        scriptId: 1, url: 'fixture.js', functionName: 'second', lineNumber: 0, columnNumber: 20, start: 20, end: 30
    }, scriptsMap);
    const event = (name: string, frame: typeof first, tm: number, duration: number, allocationStart: number, allocationEnd: number): UniformCompilationRecord => ({
        name, tm, duration, scriptId: 1, start: frame.start, end: frame.end, line: null, column: null,
        functionName: null, allocationStart, allocationEnd, eventIndex: null, event: null, callFrame: null
    });
    const events = [
        event('Finalize', second, 20, 5, 12, 15),
        event('Compile', first, 0, 100, 10, 20),
        event('Inner', second, 21, 2, 12, 15),
        event('Empty', first, 22, 1, 14, 14)
    ];
    const records = prepareCompilationRecords(events, []);
    const ids = [10, 11, 12, 13, 15, 16, 20, 21];
    const owner = createMemlineAllocationOwnerAttribute(records, ids)!;
    const stage = createMemlineAllocationCompilationStageAttribute(records, ids)!;
    assert.deepEqual(Array.from(owner.values, index => owner.dict[index]?.start ?? null), [null, 10, 10, 20, 20, 10, 10, null]);
    assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), ['none', 'Compile', 'Compile', 'Inner', 'Inner', 'Compile', 'Compile', 'none']);
    assert.equal(owner.values.byteLength + stage.values.byteLength, 8 * 5);
    assert.deepEqual(events.map(event => event.name), ['Finalize', 'Compile', 'Inner', 'Empty']);
    assert.deepEqual([...createMemlineAllocationOwnerAttribute([events[3]], [14])!.values], [0]);
    const emptyStage = createMemlineAllocationCompilationStageAttribute([events[3]], [14])!;
    assert.deepEqual(emptyStage.dict, ['none', 'Empty']);
    assert.deepEqual([...emptyStage.values], [0]);
});

test('reuses allocation buffers and reads lifespan before remapping GC epochs', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const sizes = new Uint32Array([16, 32, 48]);
    const gc = new Uint32Array([0, 5, 10]);
    const types = new Uint32Array([7, 7, 9]);
    const spaces = new Uint32Array([2, 4, 2]);
    const line = await createMemline({
        startTime: 0, endTime: 0, nodes: [], samples: [], timeDeltas: [],
        _cpuproAllocationSizes: sizes, _cpuproAllocationGc: gc,
        _cpuproAllocationTypes: types, _cpuproAllocationTypeNames: { 7: 'FIRST_TYPE', 9: 'SECOND_TYPE' },
        _cpuproAllocationSpaces: spaces, _cpuproAllocationSpaceNames: { 2: 'new_space', 4: 'old_space' }
    }, dictionary, scriptsMap, null, null, Promise.resolve());

    assert.ok(line);
    assert.equal(line.values.buffer, sizes.buffer);
    assert.equal(line.attributes.find(attribute => attribute.name === 'allocationType')!.values.buffer, types.buffer);
    assert.equal(line.attributes.find(attribute => attribute.name === 'allocationSpace')!.values.buffer, spaces.buffer);
    assert.equal(line.attributes.find(attribute => attribute.name === 'allocationGcEpoch')!.values.buffer, gc.buffer);
    assert.deepEqual([...types], [0, 0, 1]);
    assert.deepEqual([...spaces], [0, 1, 0]);
    assert.deepEqual([...gc], [0, 1, 2]);
    assert.deepEqual([...line.attributes.find(attribute => attribute.name === 'allocationType')!.values], [0, 0, 1]);
    assert.deepEqual([...line.attributes.find(attribute => attribute.name === 'allocationSpace')!.values], [0, 1, 0]);
    assert.deepEqual([...line.attributes.find(attribute => attribute.name === 'allocationLifespan')!.values], [0, 1, 2]);
});

test('decodes unsigned GC epochs without losing the high bit', () => {
    const gc = new Uint32Array([0x80000001]);
    const lifespan = createMemlineAllocationLifespanAttribute(gc)!;
    const epochs = createMemlineGcEpochAttribute(gc)!;

    assert.deepEqual([...lifespan.values], [1]);
    assert.equal(epochs.values, gc);
    assert.deepEqual([...epochs.values], [0]);
    assert.equal(epochs.dict[0].epoch, 0x20000000);
    assert.equal(epochs.dict[0].type, 'minor');
});

test('decodes unsigned builtin IDs from allocation context info', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const resolve = vi.spyOn(dictionary, 'resolveCallFrame');

    try {
        const locations = createVectorLocations(
            dictionary, scriptsMap, new Int32Array([0]), new Int32Array([-1]),
            new Uint32Array([0x80000000]), null, null
        );
        const names = resolve.mock.calls.map(([frame]) => frame.functionName);

        assert.ok(locations);
        assert.ok(names.includes('(builtin) unknown-builtin[134217728]'));
    } finally {
        resolve.mockRestore();
    }
});
