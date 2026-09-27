import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { createProfileSession } from '../profile-session.mjs';
import { extractFromChromiumPerformanceProfile } from '../formats/chromium-performance-profile.js';
import type { UniformCompilationRecord } from '../formats/types.js';
import type { CpuProCompilationRecord } from '../types.js';
import { createWorkHandler } from '../misc/work.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';
import * as computations from '../computations/misc.js';
import * as utils from '../formats/utils.js';
import {
    createMemlineAllocationOwnerAttribute,
    createMemlineAllocationCompilationStageAttribute
} from '../lines/memline-attributes.mjs';
import { collectProfileUsedScriptIds, OriginalScriptsMap, ProfileScriptsMap } from './scripts.js';
import { prepareCompilationRecords, resolveCompilationCallFrames } from './compilation-events.js';

function record(overrides: Partial<UniformCompilationRecord> = {}): UniformCompilationRecord {
    return {
        name: 'Compile', tm: 100, duration: 10, scriptId: 7, start: 14, end: 30,
        line: 0, column: 14, functionName: null, allocationStart: 0, allocationEnd: 0,
        eventIndex: null, event: null, callFrame: null,
        ...overrides
    };
}

function sourceFixture(cpuOnly = false) {
    const base = { pid: 1, tid: 2, ts: 1000, ph: 'P', cat: 'profile', id: 'cpu' };
    const session = extractFromChromiumPerformanceProfile([
        { ...base, name: 'Profile', args: { data: { startTime: 1000, isolate: 'test' } } },
        { ...base, name: 'ProfileChunk', args: { data: {
            endTime: 1040, cpuProfile: {
                nodes: [
                    { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2] },
                    { id: 2, callFrame: { scriptId: 7, url: 'fixture.js', functionName: 'known', lineNumber: 0, columnNumber: 14, start: 14, end: 30 } }
                ],
                samples: [2, 2, 2]
            }, timeDeltas: [10, 10, 10]
        } } }
    ]);
    const data = session.profiles[0];
    const sourceMap = { version: '3', file: 'fixture.js', sources: ['original.js'], names: [], mappings: 'AAAA', sourcesContent: [''] };

    data._scripts = [
        { id: 7, url: 'fixture.js', source: '', sourceMap },
        { id: 8, url: 'event-only.js', source: 'function freshName() {}', sourceMap }
    ];
    data._samplePositions = [15, 15, 15];
    session.threads[0].compilations = [
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ scriptId: 8, start: 18, end: 24 })
    ];

    if (!cpuOnly) {
        Object.assign(data, {
            _cpuproAllocationIds: [10, 11, 20, 21],
            _cpuproAllocationMapping: [10, 20, 21],
            _cpuproAllocationSizes: [8, 16, 32, 64],
            _cpuproAllocationScriptIds: [7, 7, 7, 7],
            _cpuproAllocationLocations: [14, 14, 14, 14]
        });
    }

    const dictionary = new Dictionary();
    const source = createProfileSession(session, dictionary);

    return { data, records: source.profiles[0].thread.compilations!, dictionary, source, rawSession: session };
}

function attributes(records: CpuProCompilationRecord[], ids: number[], order: 'consecutive' | null = null) {
    return {
        owner: createMemlineAllocationOwnerAttribute(records, ids, order)!,
        stage: createMemlineAllocationCompilationStageAttribute(records, ids, order)!
    };
}

test('allocation rows map to innermost owner and stage with exclusive starts and inclusive ends', () => {
    const records = [
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Inner', start: 30, allocationStart: 12, allocationEnd: 15 }),
        record({ name: 'Empty', allocationStart: 14, allocationEnd: 14 }),
        record({ name: 'Absent', allocationStart: null, allocationEnd: null })
    ];

    for (const ids of [[10, 11, 12, 13, 14, 15, 16, 20, 21], [0, 11, 13, 20, 30], [10, 11, 13, 13, 20, 21]]) {
        for (const input of [records, records.slice().reverse()]) {
            const prepared = prepareCompilationRecords(input, []);
            const { owner, stage } = attributes(prepared, ids);
            const expected = ids.map(id => id > 12 && id <= 15 ? 'Inner' : id > 10 && id <= 20 ? 'Compile' : 'none');

            assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), expected);
            assert.deepEqual(Array.from(owner.values, index => owner.dict[index]?.start ?? null),
                expected.map(name => name === 'Inner' ? 30 : name === 'Compile' ? 14 : null));
            assert.deepEqual(new Set(stage.dict), new Set(['none', 'Compile', 'Inner', 'Empty', 'Absent']));
            assert.deepEqual(owner.dict.slice(1).map(entry => entry!.start).sort(), [14, 30]);
        }
    }

    assert.equal(createMemlineAllocationOwnerAttribute([], [1]), null);
    assert.equal(createMemlineAllocationCompilationStageAttribute([], [1]), null);
    assert.equal(createMemlineAllocationOwnerAttribute(records, null), null);
    assert.equal(createMemlineAllocationCompilationStageAttribute(records, null), null);
});

test('owner dictionary keys compiled functions by raw script and start, not resolved frames', () => {
    const records = [
        record({ start: 20, allocationStart: 0, allocationEnd: 1 }),
        record({ name: 'Finalize', start: 20, allocationStart: 1, allocationEnd: 2 }),
        record({ start: 21, allocationStart: 2, allocationEnd: 3 }),
        record({ scriptId: null, start: null, allocationStart: 3, allocationEnd: 4 })
    ];
    const { owner, stage } = attributes(records, [1, 2, 3, 4, 5]);

    assert.deepEqual(owner.dict, [null, { scriptId: 7, start: 20 }, { scriptId: 7, start: 21 }, { scriptId: null, start: null }]);
    assert.deepEqual([...owner.values], [1, 1, 2, 3, 0]);
    assert.deepEqual(stage.dict, ['none', 'Compile', 'Finalize']);
    assert.deepEqual([...stage.values], [1, 2, 1, 1, 0]);

    for (const count of [255, 256]) {
        const many = Array.from({ length: count }, (_, index) => record({ name: `Stage ${index}`, allocationStart: index, allocationEnd: index + 1 }));
        const result = attributes(many, Array.from({ length: count }, (_, index) => index + 1)).stage;

        assert.ok(result.values instanceof (count === 255 ? Uint8Array : Uint32Array));
        assert.equal(result.values[count - 1], count);
    }
});

test('known consecutive ids avoid rescanning and ordered intervals avoid sorting', () => {
    const records = [record({ allocationStart: 10, allocationEnd: 20 }), record({ name: 'Inner', allocationStart: 12, allocationEnd: 15 })];
    let reads = 0;
    const ids = new Proxy(Array.from({ length: 1000 }, (_, index) => index + 10), {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads++;
            }

            return Reflect.get(target, property, target);
        }
    });
    const classify = vi.spyOn(utils, 'getNumericArrayOrder');
    const search = vi.spyOn(computations, 'lowerBound');
    const sort = vi.spyOn(Array.prototype, 'sort');

    try {
        attributes(records, ids, 'consecutive');

        assert.equal(reads, 2);
        assert.equal(classify.mock.calls.length, 0);
        assert.equal(search.mock.calls.length, 0);
        assert.equal(sort.mock.calls.length, 0);
    } finally {
        classify.mockRestore();
        search.mockRestore();
        sort.mockRestore();
    }
});

test('call frames resolve late by script and start without changing owner identities', () => {
    const records = [record({ start: 20 }), record({ start: 21 }), record({ scriptId: null, start: null }), record({ scriptId: 99 })];
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 7, url: 'fixture.js', source: 'const run = function() {};' }]);
    const named = dictionary.resolveCallFrame({
        scriptId: 7, url: 'fixture.js', functionName: 'runtimeName', lineNumber: 0, columnNumber: 20, start: 20, end: 24
    }, scripts);
    const frameCount = dictionary.callFrames.length;
    const { owner } = attributes(records, [1]);
    const dict = structuredClone(owner.dict);

    resolveCompilationCallFrames(records, dictionary, scripts);

    assert.deepEqual(records.map(record => record.callFrame), [named, named, null, null]);
    assert.deepEqual(owner.dict, dict);
    assert.equal(owner.dict.length, 5);
    assert.equal(dictionary.callFrames.length, frameCount);
});

test('session links events once per thread without mutating raw records', () => {
    const { rawSession, dictionary } = sourceFixture();
    const rawThread = rawSession.threads[0];
    const event = {
        name: 'Compile', cat: 'fixture', tm: 100, duration: 10,
        eventId: null, sampleTraceId: null, data: null
    };
    const records = [record({ eventIndex: 0 }), record(), record({ eventIndex: 99 })];
    rawThread.events = [event];
    rawThread.compilations = records;
    const before = structuredClone(records);
    records.forEach(Object.freeze);
    Object.freeze(records);
    rawSession.profiles.push({ ...rawSession.profiles[0] });

    const { profiles } = createProfileSession(rawSession, dictionary);
    const { compilations } = profiles[0].thread;

    assert.ok(compilations);
    assert.equal(profiles[1].thread.compilations, compilations);
    assert.notEqual(compilations, records);
    assert.equal(compilations[0].event, event);
    assert.deepEqual(compilations.slice(1).map(record => record.event), [null, null]);
    assert.deepEqual(compilations.map(record => ({ ...record, event: null })), before);
    assert.deepEqual(records, before);
    assert.ok(profiles.every(profile => !('compilations' in profile)));
});

test('thread preparation orders source intervals without allocation rows and preserves provenance', () => {
    const event = { name: 'Inner', cat: 'fixture', tm: 102, duration: 2, eventId: null, sampleTraceId: null, data: null };
    const input = [
        record({ name: 'Inner', allocationStart: 12, allocationEnd: 15, tm: 102, duration: 2, eventIndex: 0 }),
        record({ name: 'EqualBounds', allocationStart: 12, allocationEnd: 15, tm: 101, duration: 5 }),
        record({ name: 'Outer', allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'TimeOnly', allocationStart: null, allocationEnd: null }),
        record({ name: 'Empty', allocationStart: 14, allocationEnd: 14 })
    ];
    const before = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);

    const prepared = prepareCompilationRecords(input, [event]);

    assert.deepEqual(prepared.map(record => record.name), ['Outer', 'EqualBounds', 'Inner', 'Empty', 'TimeOnly']);
    assert.equal(prepared[2].event, event);
    assert.deepEqual(prepared.map(record => ({ ...record, event: null })).sort((left, right) => left.name.localeCompare(right.name)),
        before.slice().sort((left, right) => left.name.localeCompare(right.name)));
    assert.deepEqual(input, before);
});

test('empty allocation intervals do not trigger sorting of otherwise ordered source records', () => {
    const input = [
        record({ name: 'Outer', allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Empty', allocationStart: 19, allocationEnd: 19 }),
        record({ name: 'TimeOnly', allocationStart: null, allocationEnd: null }),
        record({ name: 'Inner', allocationStart: 12, allocationEnd: 15 })
    ];
    const sort = vi.spyOn(Array.prototype, 'sort');

    try {
        const prepared = prepareCompilationRecords(input, []);

        assert.equal(sort.mock.calls.length, 0);
        assert.deepEqual(prepared, input);
        const { stage } = attributes(prepared, [11, 13, 19]);
        assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), ['Outer', 'Inner', 'Outer']);
    } finally {
        sort.mockRestore();
    }
});

test('thread records remain available without capture or isolate agreement', () => {
    const { data, records, dictionary, rawSession } = sourceFixture();

    assert.deepEqual([...collectProfileUsedScriptIds(data, records)], [0, 7, 8]);
    rawSession.threads[0].isolate = 'different';
    data._capture = undefined;
    assert.deepEqual(createProfileSession(rawSession, dictionary).profiles[0].thread.compilations, records);
});

test('one thread supplies source intervals to independent allocation captures', () => {
    const { rawSession, dictionary } = sourceFixture(true);
    rawSession.threads[0].compilations = [
        record({ name: 'Inner', start: 30, allocationStart: 12, allocationEnd: 15 }),
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Empty', allocationStart: 14, allocationEnd: 14 })
    ];
    rawSession.profiles.push({ ...rawSession.profiles[0] });
    const { profiles } = createProfileSession(rawSession, dictionary);
    const records = profiles[0].thread.compilations!;
    records.forEach(Object.freeze);
    Object.freeze(records);
    const firstIds = [11, 13, 16, 21];
    const secondIds = [9, 15, 20];
    Object.freeze(firstIds);
    Object.freeze(secondIds);

    const first = attributes(records, firstIds);
    const second = attributes(profiles[1].thread.compilations!, secondIds);

    assert.equal(records, profiles[1].thread.compilations);
    assert.deepEqual(first.owner.dict, second.owner.dict);
    assert.notEqual(first.owner.values, second.owner.values);
    assert.deepEqual(Array.from(first.stage.values, index => first.stage.dict[index]), ['Compile', 'Inner', 'Compile', 'none']);
    assert.deepEqual(Array.from(second.stage.values, index => second.stage.dict[index]), ['none', 'Inner', 'Compile']);
    assert.deepEqual(firstIds, [11, 13, 16, 21]);
    assert.deepEqual(secondIds, [9, 15, 20]);
});

test.each([false, true])('profile preserves parser overlap and resolves records before source maps (CPU-only: %s)', async cpuOnly => {
    const { data, records, dictionary } = sourceFixture(cpuOnly);
    const stages: string[] = [];
    let finishParsing!: () => void;
    let parsingPending = true;
    const parsing = new Promise<void>(resolve => {
        finishParsing = resolve;
    });
    const parser = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockImplementationOnce(async scripts => {
        assert.ok([...scripts].some(script => script.url === 'event-only.js'));
        await parsing;

        for (const script of scripts) {
            scriptFunctions.getFunctionAtScriptOffset(script, 0);
        }

        parsingPending = false;
    });
    const work = createWorkHandler(async ({ name }, task) => {
        if (name === (cpuOnly ? 'link compilation events' : 'parse script sources')) {
            assert.equal(parsingPending, true);
            assert.ok(records.every(record => record.callFrame === null));

            if (!cpuOnly) {
                assert.ok(stages.includes('create memline attributes'));
                assert.ok(stages.includes('map allocations to CPU samples'));
            }

            finishParsing();
        }

        const result = await task();
        stages.push(name);
        return result;
    });

    try {
        const profile = await createProfile({ ...data, _capture: undefined }, { compilations: records, dictionary, work });
        const known = records.find(record => record.scriptId === 7)!;
        const fresh = records.find(record => record.scriptId === 8)!;

        assert.equal('compilation' in profile, false);
        assert.equal(known.callFrame!.name, 'known');
        assert.equal(fresh.callFrame!.name, 'freshName');
        assert.ok(profile.callFrames.some(frame => frame.script?.originalFor === fresh.callFrame!.script));
        assert.ok(stages.indexOf('link compilation events') < stages.indexOf('process source maps'));

        if (cpuOnly) {
            assert.equal(profile.memline, null);
        } else {
            const owner = profile.memline!.attributes.find(attribute => attribute.name === 'allocationOwner')!;
            const stage = profile.memline!.attributes.find(attribute => attribute.name === 'allocationCompilationStage')!;
            assert.deepEqual(owner.dict, [null, ...records.map(({ scriptId, start }) => ({ scriptId, start }))]);
            assert.deepEqual(Array.from(owner.values, index => owner.dict[index]), [null, { scriptId: 7, start: 14 }, { scriptId: 7, start: 14 }, null]);
            assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), ['none', 'Compile', 'Compile', 'none']);
            assert.ok(stages.indexOf('create location breakdown') < stages.indexOf('link compilation events'));
        }
    } finally {
        finishParsing();
        parser.mockRestore();
    }
});
