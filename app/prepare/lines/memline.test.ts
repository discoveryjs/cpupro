import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { Dictionary } from '../dictionary.js';
import { OriginalScriptsMap, ProfileScriptsMap } from '../preprocessing/scripts.js';
import { noopWorkHandler } from '../misc/work.js';
import { createMemline } from './memline.mjs';
import { createMemlineAllocationOwnerAttribute, createMemlineAllocationCompilationStageAttribute } from './memline-attributes.mjs';
import { prepareCompilationEvents, resolveCompilationOwners, type CompilationEvent } from '../preprocessing/compilation-events.js';

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
    const event = (name: string, frame: typeof first, tm: number, duration: number, startAllocationId: number, endAllocationId: number): CompilationEvent => ({
        name, cat: 'disabled-by-default-v8.compilation_allocations', tm, duration,
        eventId: null, sampleTraceId: null, callFrame: frame, selfTime: duration,
        data: { data: { scriptId: 1, start: frame.start, startAllocationId, endAllocationId } }
    });
    const events = [
        event('Finalize', second, 20, 5, 12, 15),
        event('Compile', first, 0, 100, 10, 20),
        event('Inner', second, 21, 2, 12, 15),
        event('Empty', first, 22, 1, 14, 14)
    ];
    const compilation = prepareCompilationEvents({
        _events: events,
        _cpuproAllocationIds: [10, 11, 12, 13, 15, 16, 20, 21]
    })!;
    const owner = createMemlineAllocationOwnerAttribute(compilation)!;
    const stage = createMemlineAllocationCompilationStageAttribute(compilation)!;
    resolveCompilationOwners(compilation, dictionary, scriptsMap);
    assert.deepEqual(Array.from(owner.values, index => owner.dict[index]), [null, first, first, second, second, first, first, null]);
    assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), ['none', 'Compile', 'Compile', 'Inner', 'Inner', 'Compile', 'Compile', 'none']);
    assert.equal(owner.values.byteLength + stage.values.byteLength, 8 * 5);
    assert.deepEqual(events.map(event => event.name), ['Finalize', 'Compile', 'Inner', 'Empty']);
    const empty = prepareCompilationEvents({ _events: [events[3]], _cpuproAllocationIds: [14] })!;
    assert.deepEqual([...createMemlineAllocationOwnerAttribute(empty)!.values], [0]);
    const emptyStage = createMemlineAllocationCompilationStageAttribute(empty)!;
    assert.deepEqual(emptyStage.dict, ['none', 'Empty']);
    assert.deepEqual([...emptyStage.values], [0]);
});
