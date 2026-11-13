import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { createProfileSession } from '../profile-session.mjs';
import { extractFromChromiumPerformanceProfile } from '../formats/chromium-performance-profile.js';
import type { CpuProCompilationRecord, CpuProCompilationSubject, CpuProScript } from '../types.js';
import type { CompilationOwners, ProfileMemline } from '../lines/types.js';
import { createWorkHandler, type WorkWrapperChain } from '../misc/work.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';
import * as computations from '../computations/misc.js';
import {
    createMemlineCompilationAttributes
} from '../lines/memline-attributes.mjs';
import { createCompilationRecords } from './compilation-events.js';
import { createCompilationRecord, prepareCompilationRecords } from '../../../test/fixtures/compilation.js';

// Records default to the fixture function `known` at 14..30 (line 0, column 14) of script 7
function record(fields: Partial<CpuProCompilationRecord> = {}) {
    return createCompilationRecord({
        start: 14,
        end: 30,
        line: 0,
        column: 14,
        ...fields
    });
}

function sourceFixture(cpuOnly = false) {
    const base = {
        pid: 1,
        tid: 2,
        ts: 1000,
        ph: 'P',
        cat: 'profile',
        id: 'cpu'
    };
    const root = {
        scriptId: 0,
        url: '',
        functionName: '(root)',
        lineNumber: -1,
        columnNumber: -1
    };
    const known = {
        scriptId: 7,
        url: 'fixture.js',
        functionName: 'known',
        lineNumber: 0,
        columnNumber: 14,
        start: 14,
        end: 30
    };
    const cpuProfile = {
        nodes: [
            { id: 1, callFrame: root, children: [2] },
            { id: 2, callFrame: known }
        ],
        samples: [2, 2, 2]
    };
    const chunk = { endTime: 1040, cpuProfile, timeDeltas: [10, 10, 10] };
    const session = extractFromChromiumPerformanceProfile([
        {
            ...base,
            name: 'Profile',
            args: { data: { startTime: 1000, isolate: 'test' } }
        },
        {
            ...base,
            name: 'ProfileChunk',
            args: { data: chunk }
        }
    ]);
    const data = session.profiles[0];
    const sourceMap = {
        version: '3',
        file: 'fixture.js',
        sources: ['original.js'],
        names: [],
        mappings: 'AAAA',
        sourcesContent: ['']
    };

    data._scripts = [
        {
            id: 7,
            url: 'fixture.js',
            source: '',
            sourceMap
        },
        {
            id: 8,
            url: 'event-only.js',
            source: 'function freshName() {}',
            sourceMap
        }
    ];
    data._samplePositions = [15, 15, 15];
    session.threads[0].compilations = [
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ scriptId: 8, start: 18, end: data._scripts[1].source!.length })
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

    return {
        data,
        records: source.profiles[0].thread.compilations!,
        subjects: source.profiles[0].thread.compilationSubjects!,
        dictionary,
        source,
        rawSession: session
    };
}

// Dictionary entries of the attribute values
function dictValues<T>(attribute: { keys: ArrayLike<number>; dict: T[] }) {
    return Array.from(attribute.keys, index => attribute.dict[index]);
}

// Subjects of the allocations, as queries read them, null for allocations without an owner
function ownerSubjects(owners: CompilationOwners) {
    return Array.from(owners.values, index => owners.dict[index] ?? null);
}

function attributes(records: CpuProCompilationRecord[], ids: number[], order: 'consecutive' | null = null) {
    const { owners, stage } = createMemlineCompilationAttributes(records, ids, order);

    return {
        owners: owners!,
        stage: stage!
    };
}

test('allocation rows map to innermost owner and stage with exclusive starts and inclusive ends', () => {
    const records = [
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Inner', start: 30, allocationStart: 12, allocationEnd: 15 }),
        record({ name: 'Empty', allocationStart: 14, allocationEnd: 14 }),
        record({ name: 'Absent', allocationStart: null, allocationEnd: null })
    ];

    // allocation ranges are (start, end]: Compile owns (10, 20] at 14, the innermost Inner owns (12, 15] at 30
    const cases = [
        {
            ids: [10, 11, 12, 13, 14, 15, 16, 20, 21],
            stages: ['none', 'Compile', 'Compile', 'Inner', 'Inner', 'Inner', 'Compile', 'Compile', 'none'],
            owners: [null, 14, 14, 30, 30, 30, 14, 14, null]
        },
        {
            ids: [0, 11, 13, 20, 30],
            stages: ['none', 'Compile', 'Inner', 'Compile', 'none'],
            owners: [null, 14, 30, 14, null]
        },
        {
            ids: [10, 11, 13, 13, 20, 21],
            stages: ['none', 'Compile', 'Inner', 'Inner', 'Compile', 'none'],
            owners: [null, 14, 30, 30, 14, null]
        }
    ];

    for (const expected of cases) {
        const { ids, stages, owners } = expected;

        for (const input of [records, records.slice().reverse()]) {
            const prepared = createCompilationRecords(input, []);

            prepareCompilationRecords(prepared);

            const attributesOf = attributes(prepared, ids);

            assert.deepEqual(dictValues(attributesOf.stage), stages);
            assert.deepEqual(ownerSubjects(attributesOf.owners, ids.length).map(entry => entry?.start ?? null), owners);
            assert.deepEqual(new Set(attributesOf.stage.dict), new Set(['none', 'Compile', 'Inner', 'Empty', 'Absent']));
            assert.deepEqual(attributesOf.owners.dict.map(entry => entry.start).sort(), [14, 30]);
        }
    }

    assert.deepEqual(createMemlineCompilationAttributes([], [1]), { owners: null, stage: null });
    assert.deepEqual(createMemlineCompilationAttributes(records, null), { owners: null, stage: null });
});

test('a record over a part of the allocations of a record before it owns them, the record before it the rest', () => {
    const records = createCompilationRecords([
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Later', start: 30, allocationStart: 15, allocationEnd: 25 })
    ], []);

    prepareCompilationRecords(records);

    const ids = [10, 11, 15, 16, 20, 21, 25, 26];
    const { owners } = attributes(records, ids);

    assert.deepEqual(ownerSubjects(owners, ids.length).map(entry => entry?.start ?? null), [
        null, 14, 14, 30, 30, 30, 30, null
    ]);
    assert.deepEqual([[...owners.starts], [...owners.ends]], [[1, 3], [3, 7]]);
});

test('owners are the compilation subjects of records, by raw script and range, not resolved frames', () => {
    const records = [
        record({ start: 20, allocationStart: 0, allocationEnd: 1 }),
        record({ name: 'Finalize', start: 20, allocationStart: 1, allocationEnd: 2 }),
        record({ start: 21, allocationStart: 2, allocationEnd: 3 }),
        record({ scriptId: null, start: null, allocationStart: 3, allocationEnd: 4 }),
        record({ start: 20, end: 40, allocationStart: 4, allocationEnd: 5 })
    ];

    prepareCompilationRecords(records);

    const { owners, stage } = attributes(records, [1, 2, 3, 4, 5, 6]);
    const range = (subject: CpuProCompilationSubject) => [subject.scriptId, subject.start, subject.end];

    assert.deepEqual(owners.dict.map(range), [
        [7, 20, 30],
        [7, 21, 30],
        [null, null, 30],
        [7, 20, 40]
    ]);
    // Allocations of one subject in a row are one run, the last allocation has no owner
    assert.deepEqual([[...owners.starts], [...owners.ends], [...owners.subjects]], [[0, 2, 3, 4], [2, 3, 4, 5], [0, 1, 2, 3]]);
    assert.deepEqual(stage.dict, ['none', 'Compile', 'Finalize']);
    assert.deepEqual([...stage.keys], [1, 2, 1, 1, 1, 0]);

    // 255 stages and 'none' fit byte indices, one more stage does not
    const sizes = [
        { count: 255, IndexArray: Uint8Array },
        { count: 256, IndexArray: Uint32Array }
    ];

    for (const size of sizes) {
        const { count, IndexArray } = size;
        const many: CpuProCompilationRecord[] = [];
        const ids: number[] = [];

        for (let i = 0; i < count; i++) {
            many.push(record({ name: `Stage ${i}`, allocationStart: i, allocationEnd: i + 1 }));
            ids.push(i + 1);
        }

        prepareCompilationRecords(many);

        const result = attributes(many, ids).stage;

        assert.ok(result.keys instanceof IndexArray);
        assert.equal(result.keys[count - 1], count);
    }
});

test('consecutive allocation ids are located by offset without scanning or searching', () => {
    const records = [
        record({ allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'Inner', allocationStart: 12, allocationEnd: 15 })
    ];
    let reads = 0;
    const ids = new Proxy(Array.from({ length: 1000 }, (_, i) => i + 10), {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads++;
            }

            return Reflect.get(target, property, target);
        }
    });
    const search = vi.spyOn(computations, 'lowerBound');

    prepareCompilationRecords(records);

    try {
        const { stage } = attributes(records, ids, 'consecutive');

        // Only the first id is read
        assert.equal(reads, 1);
        assert.equal(search.mock.calls.length, 0);
        assert.deepEqual(dictValues(stage).slice(0, 12), [
            'none',
            'Compile',
            'Compile',
            'Inner',
            'Inner',
            'Inner',
            'Compile',
            'Compile',
            'Compile',
            'Compile',
            'Compile',
            'none'
        ]);
    } finally {
        search.mockRestore();
    }
});

test('session links events once per thread without mutating raw records', () => {
    const { rawSession, dictionary } = sourceFixture();
    const rawThread = rawSession.threads[0];
    const event = {
        name: 'Compile',
        cat: 'fixture',
        tm: 100,
        duration: 10,
        eventId: null,
        sampleTraceId: null,
        data: null
    };
    const records = [record({ eventIndex: 0 }), record(), record({ eventIndex: 99 })];
    const before = structuredClone(records);

    rawThread.events = [event];
    rawThread.compilations = records;

    for (let i = 0; i < records.length; i++) {
        Object.freeze(records[i]);
    }

    Object.freeze(records);
    rawSession.profiles.push({ ...rawSession.profiles[0] });

    const { profiles } = createProfileSession(rawSession, dictionary);
    const { compilations } = profiles[0].thread;

    assert.ok(compilations);
    assert.equal(profiles[1].thread.compilations, compilations);
    assert.notEqual(compilations, records);
    assert.equal(compilations[0].event, event);
    assert.deepEqual(compilations.slice(1).map(record => record.event), [null, null]);
    assert.deepEqual(compilations.map(record => ({ ...record, event: null, subject: null })), before);
    assert.deepEqual(records, before);
    assert.ok(profiles.every(profile => !('compilations' in profile)));
});

test('thread preparation orders source intervals without allocation rows and preserves provenance', () => {
    const event = {
        name: 'Inner',
        cat: 'fixture',
        tm: 102,
        duration: 2,
        eventId: null,
        sampleTraceId: null,
        data: null
    };
    const input = [
        record({
            name: 'Inner',
            allocationStart: 12,
            allocationEnd: 15,
            tm: 102,
            duration: 2,
            eventIndex: 0
        }),
        record({
            name: 'EqualBounds',
            allocationStart: 12,
            allocationEnd: 15,
            tm: 101,
            duration: 5
        }),
        record({ name: 'Outer', allocationStart: 10, allocationEnd: 20 }),
        record({ name: 'TimeOnly', allocationStart: null, allocationEnd: null }),
        record({ name: 'Empty', allocationStart: 14, allocationEnd: 14 })
    ];
    const before = structuredClone(input);
    const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);

    for (let i = 0; i < input.length; i++) {
        Object.freeze(input[i]);
    }

    Object.freeze(input);

    const prepared = createCompilationRecords(input, [event]);
    const withoutEvents = prepared.map(record => ({ ...record, event: null }));

    assert.deepEqual(prepared.map(record => record.name), ['Outer', 'EqualBounds', 'Inner', 'Empty', 'TimeOnly']);
    assert.equal(prepared[2].event, event);
    assert.deepEqual(withoutEvents.sort(byName), before.slice().sort(byName));
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
        const prepared = createCompilationRecords(input, []);

        assert.equal(sort.mock.calls.length, 0);
        assert.deepEqual(prepared, input);

        prepareCompilationRecords(prepared);

        const { stage } = attributes(prepared, [11, 13, 19]);

        assert.deepEqual(dictValues(stage), ['Outer', 'Inner', 'Outer']);
    } finally {
        sort.mockRestore();
    }
});

test('thread records remain available without capture or isolate agreement', () => {
    const { data, records, dictionary, rawSession } = sourceFixture();

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
    const firstIds = [11, 13, 16, 21];
    const secondIds = [9, 15, 20];

    for (let i = 0; i < records.length; i++) {
        Object.freeze(records[i]);
    }

    Object.freeze(records);
    Object.freeze(firstIds);
    Object.freeze(secondIds);

    const first = attributes(records, firstIds);
    const second = attributes(profiles[1].thread.compilations!, secondIds);

    assert.equal(records, profiles[1].thread.compilations);
    assert.deepEqual(first.owners.dict, second.owners.dict);
    assert.notEqual(first.owners.starts, second.owners.starts);
    assert.deepEqual(dictValues(first.stage), ['Compile', 'Inner', 'Compile', 'none']);
    assert.deepEqual(dictValues(second.stage), ['none', 'Inner', 'Compile']);
    assert.deepEqual(firstIds, [11, 13, 16, 21]);
    assert.deepEqual(secondIds, [9, 15, 20]);
});

// Stages completed before the given stage, which must have completed
function completedBefore(stages: string[], name: string) {
    const index = stages.indexOf(name);

    assert.notEqual(index, -1, name);

    return stages.slice(0, index);
}

// Creates a profile of the source fixture, completing script parsing once the given stage starts;
// a stage records whether parsing and record resolution were still pending when it started
async function createStagedProfile(cpuOnly: boolean, parsingStage: string) {
    const { data, records, subjects, dictionary } = sourceFixture(cpuOnly);
    const stages: string[] = [];
    const pendingAt: string[] = [];
    const parsedUrls: string[] = [];
    let parsingPending = true;
    let finishParsing!: () => void;
    const parsing = new Promise<void>(resolve => {
        finishParsing = resolve;
    });
    const parseScripts = async (scripts: CpuProScript[] | Set<CpuProScript>) => {
        const requested = [...scripts];

        for (let i = 0; i < requested.length; i++) {
            parsedUrls.push(requested[i].url);
        }

        await parsing;

        for (let i = 0; i < requested.length; i++) {
            scriptFunctions.getFunctionAtScriptOffset(requested[i], 0);
        }

        parsingPending = false;
    };
    const runStage: WorkWrapperChain = async (identity, task) => {
        if (parsingPending && subjects.every(subject => subject.callFrame === null)) {
            pendingAt.push(identity.name);
        }

        if (identity.name === parsingStage) {
            finishParsing();
        }

        const result = await task();

        stages.push(identity.name);

        return result;
    };
    const parser = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockImplementationOnce(parseScripts);
    const work = createWorkHandler(runStage);

    try {
        const options = { compilations: records, compilationSubjects: subjects, dictionary, work };
        const profile = await createProfile({ ...data, _capture: undefined }, options);

        return {
            profile,
            records,
            subjects,
            stages,
            pendingAt,
            parsedUrls
        };
    } finally {
        finishParsing();
        parser.mockRestore();
    }
}

test('with allocations, parsing runs during the CPU and memline stages until the memline waits for it', async () => {
    const { stages, pendingAt } = await createStagedProfile(false, 'parse script sources');

    assert.ok(pendingAt.includes('create memline attributes'));
    assert.ok(pendingAt.includes('map allocations to CPU samples'));
    assert.equal(pendingAt.at(-1), 'parse script sources');
    assert.ok(completedBefore(stages, 'link compilation events').includes('create location breakdown'));
});

test('without allocations, scripts are parsed while CPU stages run, until compilation events are linked', async () => {
    const { profile, pendingAt } = await createStagedProfile(true, 'link compilation events');

    assert.ok(pendingAt.includes('create tree breakdown'));
    assert.equal(pendingAt.at(-1), 'link compilation events');
    assert.equal(profile.memline, null);
});

test.each([
    { cpuOnly: false, parsingStage: 'parse script sources' },
    { cpuOnly: true, parsingStage: 'link compilation events' }
])('compilation subjects resolve before source maps, including event-only scripts (CPU-only: $cpuOnly)', async row => {
    const { profile, subjects, stages, parsedUrls } = await createStagedProfile(row.cpuOnly, row.parsingStage);
    const known = subjects.find(subject => subject.scriptId === 7)!;
    const fresh = subjects.find(subject => subject.scriptId === 8)!;

    assert.ok(parsedUrls.includes('event-only.js'));
    assert.equal('compilation' in profile, false);
    assert.equal(known.callFrame!.name, 'known');
    assert.equal(fresh.callFrame!.name, 'freshName');
    assert.ok(completedBefore(stages, 'process source maps').includes('link compilation events'));
});

test('memline allocation attributes take owners and stages from the thread compilation records', async () => {
    const { profile, subjects } = await createStagedProfile(false, 'parse script sources');
    const memline = profile.memline as ProfileMemline;
    const owners = memline.compilationOwners!;
    const stage = memline.attributes.find(attribute => attribute.name === 'allocationCompilationStage')!;

    assert.equal(owners.dict.length, subjects.length);
    assert.ok(subjects.every(subject => owners.dict[subject.index] === subject));
    assert.deepEqual(ownerSubjects(owners).map(subject => subject && [subject.scriptId, subject.start]), [
        null,
        [7, 14],
        [7, 14],
        null
    ]);
    assert.deepEqual(dictValues(stage), ['none', 'Compile', 'Compile', 'none']);
});
