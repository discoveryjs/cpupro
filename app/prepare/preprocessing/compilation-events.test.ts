import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { createWorkHandler } from '../misc/work.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';
import * as computations from '../computations/misc.js';
import type { V8CompilationEvent, V8CpuProfile } from '../types.js';
import prepare from '../../setup-prepare.mjs';
import { collectProfileUsedScriptIds, OriginalScriptsMap, ProfileScriptsMap } from './scripts.js';
import { prepareCompilationEvents, resolveCompilationOwners, type CompilationEvent } from './compilation-events.js';

function event(
    data: Partial<V8CompilationEvent['data']['data']> = {},
    options: Partial<Pick<V8CompilationEvent, 'name' | 'tm' | 'duration'>> = {}
): CompilationEvent {
    return {
        name: 'Compile',
        cat: 'disabled-by-default-v8.compilation_allocations',
        tm: 100,
        duration: 10,
        eventId: null,
        sampleTraceId: null,
        ...options,
        data: { data: { scriptId: 7, start: 14, startAllocationId: 0, endAllocationId: 0, ...data } }
    } as CompilationEvent;
}

function profileFixture(cpuOnly: boolean) {
    const first = event({ startAllocationId: 10, endAllocationId: 20 });
    const source = 'function compiledOnly() {}';
    const eventOnly = event({ scriptId: 8, start: source.indexOf('(') });
    const sourceMap = {
        version: '3',
        file: 'generated.js',
        sources: ['original.js'],
        names: [],
        mappings: 'AAAA',
        sourcesContent: ['']
    };
    const data: V8CpuProfile = {
        startTime: 1000,
        endTime: 1040,
        nodes: [
            {
                id: 1,
                callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 },
                children: [2]
            },
            {
                id: 2,
                callFrame: {
                    scriptId: 7, url: 'generated.js', functionName: 'known',
                    lineNumber: 0, columnNumber: 14, start: 14, end: 30
                }
            }
        ],
        samples: [2, 2, 2],
        timeDeltas: [10, 10, 10],
        _samplePositions: [15, 15, 15],
        _scripts: [
            { id: 7, url: 'generated.js', source: '', sourceMap },
            { id: 8, url: 'event-only.js', source, sourceMap }
        ],
        _events: [first, eventOnly]
    };

    if (!cpuOnly) {
        Object.assign(data, {
            _cpuproAllocationIds: [10, 11, 20, 21],
            _cpuproAllocationMapping: [10, 20, 21],
            _cpuproAllocationSizes: [8, 16, 32, 64],
            _cpuproAllocationScriptIds: [7, 7, 7, 7],
            _cpuproAllocationLocations: [14, 14, 14, 14]
        });
    }

    return { data, first, eventOnly };
}

test('used script ids combine optional arrays without treating arbitrary values as event lists', () => {
    const { data } = profileFixture(false);

    data._callFrames = [{ scriptId: '9', url: '', functionName: '', lineNumber: 0, columnNumber: 0 }];
    data._cpuproAllocationScriptIds = [7, '9', 10];
    data._events!.push({ ...event({ scriptId: 99 }), cat: 'unrelated' });

    assert.deepEqual([...collectProfileUsedScriptIds(data)], [0, 7, '9', 10, 8]);

    for (const value of [undefined, null, {}, { length: 1 }]) {
        const input = { ...data, _events: value } as V8CpuProfile;

        assert.deepEqual([...collectProfileUsedScriptIds(input)], [0, 7, '9', 10]);
    }
});

test('ordered events skip sorting and the fallback preserves equal-time nesting', () => {
    const outer = event({ start: 10 }, { tm: 0, duration: 100 });
    const inner = event({ start: 20 }, { tm: 0, duration: 30 });
    const instant = event({ start: 20 }, { tm: 10, duration: 0 });
    const later = event({ start: 30 }, { tm: 50, duration: 20 });
    const ordered = [outer, inner, instant, later];
    const unordered = [inner, outer, later, instant];
    const sort = vi.spyOn(Array.prototype, 'sort');

    try {
        prepareCompilationEvents({ _events: ordered });

        assert.equal(sort.mock.calls.length, 0);
        assert.deepEqual(ordered.map(event => event.selfTime), [50, 30, 0, 20]);

        prepareCompilationEvents({ _events: unordered });

        assert.equal(sort.mock.calls.length, 1);
        assert.deepEqual(unordered, [inner, outer, later, instant]);
        assert.deepEqual(ordered.map(event => event.selfTime), [50, 30, 0, 20]);
    } finally {
        sort.mockRestore();
    }
});

test('shared events retain source identity and unrelated events do not affect compilation', () => {
    const outer = event({ startAllocationId: 10, endAllocationId: 20 }, { tm: 0, duration: 100 });
    const inner = event({ startAllocationId: 12, endAllocationId: 15 }, { name: 'Parse', tm: 0, duration: 30 });
    const unrelated = Object.freeze({ ...event(), cat: 'other', tm: -100, duration: 1000, data: null });
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 7, url: 'fixture.js', source: '' }]);

    for (const events of [[unrelated, outer, unrelated, inner], [inner, unrelated, outer]]) {
        const original = events.slice();
        const compilation = prepareCompilationEvents({ _events: events, _cpuproAllocationIds: [10, 11, 13, 20, 21] })!;

        resolveCompilationOwners(compilation, dictionary, scripts);

        assert.equal(compilation.events, events);
        assert.deepEqual(events, original);
        assert.equal(outer.selfTime, 70);
        assert.equal(inner.selfTime, 30);
        assert.deepEqual([...compilation.eventOwners], events.map(event => event === unrelated ? 0 : 1));
        assert.deepEqual([...compilation.allocationOwners!], [0, 1, 1, 1, 0]);
        assert.deepEqual(Array.from(compilation.allocationStages!, index => compilation.stages[index]), ['none', 'Compile', 'Parse', 'Compile', 'none']);
        assert.equal('selfTime' in unrelated, false);
        assert.equal('callFrame' in unrelated, false);
    }

    const allocate = vi.spyOn(globalThis, 'Uint32Array');

    try {
        assert.equal(prepareCompilationEvents({ _events: [unrelated] }), null);
        assert.equal(allocate.mock.calls.length, 0);
    } finally {
        allocate.mockRestore();
    }
});

test('allocation membership preserves original rows for consecutive, sparse and reordered ids', () => {
    const outer = event({ scriptId: 7, start: 10 });
    const inner = event(
        { start: 20, startAllocationId: 11, endAllocationId: 14 },
        { name: 'Parse', tm: 102, duration: 4 }
    );
    const empty = event(
        { start: 30, startAllocationId: 12, endAllocationId: 12 },
        { name: 'Empty', tm: 103, duration: 1 }
    );
    const events = [outer, inner, empty];
    const cases = [
        [10, 11, 12, 13, 14, 15],
        [10, 12, 14, 15],
        [14, 10, 15, 12, 12],
        []
    ];
    const ranges = [[9, 16], [10, 15], [0, 5], [20, 25], [11, 11]];
    const search = vi.spyOn(computations, 'lowerBound');

    try {
        for (const ids of cases) {
            for (const [start, end] of ranges) {
                outer.data.data.startAllocationId = start;
                outer.data.data.endAllocationId = end;
                search.mockClear();

                const compilation = prepareCompilationEvents({ _events: events, _cpuproAllocationIds: ids })!;
                const expected = ids.map(id => {
                    let owner = 0;

                    for (let index = 0; index < events.length; index++) {
                        const { startAllocationId, endAllocationId } = events[index].data.data;

                        if (id > startAllocationId && id <= endAllocationId) {
                            owner = index + 1;
                        }
                    }

                    return owner;
                });

                assert.deepEqual([...compilation.allocationOwners!], expected);
                assert.deepEqual([...compilation.allocationStages!], expected);
                assert.deepEqual(compilation.stages, ['none', 'Compile', 'Parse', 'Empty']);

                if (ids === cases[0]) {
                    assert.equal(search.mock.calls.length, 0, 'Consecutive ids use arithmetic boundaries');
                } else if (ids.length > 0) {
                    assert.ok(search.mock.calls.length > 0, 'Sparse ids use the ordered fallback');
                }
            }
        }
    } finally {
        search.mockRestore();
    }
});

test('validated consecutive ids need no scan or search during compilation preparation', () => {
    const ids = Array.from({ length: 1000 }, (_, index) => index + 10);
    const order = computations.getNumericArrayOrder(ids);
    const first = event({ startAllocationId: 10, endAllocationId: 20 });
    const classify = vi.spyOn(computations, 'getNumericArrayOrder');
    const search = vi.spyOn(computations, 'lowerBound');
    let reads = 0;
    const allocationIds = new Proxy(ids, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads++;
            }

            return Reflect.get(target, property, target);
        }
    });

    try {
        const compilation = prepareCompilationEvents({
            _events: [first],
            _cpuproAllocationIds: allocationIds,
            _cpuproAllocationIdsOrder: order
        })!;

        assert.equal(classify.mock.calls.length, 0);
        assert.equal(search.mock.calls.length, 0);
        assert.equal(reads, 1, 'Only the first id is needed to calculate allocation indices');
        assert.deepEqual([...compilation.allocationOwners!.subarray(0, 12)], [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    } finally {
        classify.mockRestore();
        search.mockRestore();
    }
});

test('empty allocation input preserves event time and stage dictionaries', () => {
    assert.equal(prepareCompilationEvents({}), null);
    assert.equal(prepareCompilationEvents({ _events: [] }), null);

    for (const ids of [null, []]) {
        const first = event({}, { duration: 25 });
        const compilation = prepareCompilationEvents({ _events: [first], _cpuproAllocationIds: ids ?? undefined })!;

        assert.equal(first.selfTime, 25);
        assert.deepEqual(compilation.stages, ['none', 'Compile']);
        assert.deepEqual(compilation.allocationOwners, ids === null ? null : new Uint32Array());
        assert.deepEqual(compilation.allocationStages, ids === null ? null : new Uint8Array());
    }
});

test('stage indices widen without changing allocation membership', () => {
    for (const count of [255, 256]) {
        const events = Array.from({ length: count }, (_, index) => event(
            { startAllocationId: index, endAllocationId: index + 1 },
            { name: `Stage ${index}`, tm: index, duration: 1 }
        ));
        const ids = Array.from({ length: count }, (_, index) => index + 1);
        const compilation = prepareCompilationEvents({ _events: events, _cpuproAllocationIds: ids })!;

        assert.ok(compilation.allocationStages instanceof (count === 255 ? Uint8Array : Uint32Array));
        assert.deepEqual([...compilation.allocationStages!], [...ids]);
        assert.ok(compilation.allocationOwners!.every(owner => owner === 1));
    }
});

test('raw attribution survives late name resolution without changing its vectors', () => {
    const first = event({ start: 20, startAllocationId: 10, endAllocationId: 20 });
    const second = event(first.data.data, { name: 'Finalize', tm: 102, duration: 2 });
    const compilation = prepareCompilationEvents({
        _events: [first, second],
        _cpuproAllocationIds: [10, 11, 20, 21]
    })!;
    const vector = compilation.allocationOwners!;
    const before = vector.slice();

    assert.deepEqual([...vector], [0, 1, 1, 0]);
    assert.deepEqual(compilation.owners, [null, { scriptId: 7, start: 20 }]);
    assert.equal('callFrame' in first, false);

    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{
        id: 7, url: 'fixture.js', source: 'const run = function() {};'
    }]);
    const named = dictionary.resolveCallFrame({
        scriptId: 7, url: 'fixture.js', functionName: 'runtimeName', lineNumber: 0, columnNumber: 20, start: 20, end: 24
    }, scripts);
    const count = dictionary.callFrames.length;

    resolveCompilationOwners(compilation, dictionary, scripts);

    assert.equal(compilation.allocationOwners, vector);
    assert.deepEqual(vector, before);
    assert.equal(compilation.callFrames[1], named);
    assert.equal(first.callFrame, named);
    assert.equal(second.callFrame, named);
    assert.equal(dictionary.callFrames.length, count);
});

test('distinct raw owners keep their indices when they resolve to one frame', () => {
    const first = event({ start: 14, startAllocationId: 0, endAllocationId: 1 });
    const second = event({ start: 15, startAllocationId: 1, endAllocationId: 2 });
    const compilation = prepareCompilationEvents({ _events: [first, second], _cpuproAllocationIds: [1, 2] })!;
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 7, url: 'fixture.js', source: '' }]);
    const frame = dictionary.resolveCallFrame({
        scriptId: 7, url: 'fixture.js', functionName: 'known', lineNumber: 0, columnNumber: 14, start: 14, end: 30
    }, scripts);

    resolveCompilationOwners(compilation, dictionary, scripts);

    assert.deepEqual([...compilation.allocationOwners!], [1, 2]);
    assert.equal(compilation.callFrames.length, 3);
    assert.equal(compilation.callFrames[1], frame);
    assert.equal(compilation.callFrames[2], frame);
});

test('links compilation events to existing locations and preserves event references', () => {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{
        id: 7, url: 'generated.js', source: '', lineOffset: 4, columnOffset: 50
    }]);
    const frame = dictionary.callFrames[dictionary.resolveCallFrameIndex({
        scriptId: 7, url: 'generated.js', functionName: 'known', lineNumber: 4, columnNumber: 64, start: 14, end: 30
    }, scripts, true)];
    const first = event({ scriptId: 7, start: 14, startAllocationId: 1, endAllocationId: 2 });
    const data = first.data.data;
    const second = event(data);
    const missing = event({ scriptId: 8, start: 14 });
    const compilation = prepareCompilationEvents({ _events: [first, second, missing] })!;

    resolveCompilationOwners(compilation, dictionary, scripts);

    assert.equal(first.callFrame, frame);
    assert.equal(second.callFrame, frame);
    assert.equal(missing.callFrame, null);
    assert.equal(first.data.data, data);
});

test('uses profile-local scripts for equal offsets', () => {
    const dictionary = new Dictionary();
    const originals = new OriginalScriptsMap(dictionary);
    const firstScripts = new ProfileScriptsMap(dictionary, originals, [{ id: 7, url: 'first.js', source: '', lineOffset: 4, columnOffset: 50 }]);
    const secondScripts = new ProfileScriptsMap(dictionary, originals, [{ id: 7, url: 'second.js', source: '' }]);
    const firstFrame = dictionary.callFrames[dictionary.resolveCallFrameIndex({
        scriptId: 7, url: 'first.js', functionName: 'first', lineNumber: 5, columnNumber: 10, start: 0, end: 20
    }, firstScripts, true)];
    const secondFrame = dictionary.callFrames[dictionary.resolveCallFrameIndex({
        scriptId: 7, url: 'second.js', functionName: 'second', lineNumber: 5, columnNumber: 10, start: 0, end: 20
    }, secondScripts)];
    const data = { scriptId: 7, start: 0 };

    const first = event(data);
    const second = event(data);

    resolveCompilationOwners(prepareCompilationEvents({ _events: [first] })!, dictionary, firstScripts);
    resolveCompilationOwners(prepareCompilationEvents({ _events: [second] })!, dictionary, secondScripts);

    assert.equal(first.callFrame, firstFrame);
    assert.equal(second.callFrame, secondFrame);
    assert.notEqual(firstFrame, secondFrame);
});

test('resolves new locations once and reuses the previous script across consecutive events', () => {
    const dictionary = new Dictionary();
    const source = 'function fresh() {}\nfunction other() {}';
    const start = source.indexOf('(');
    const otherStart = source.indexOf('(', start + 1);
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [
        { id: 7, url: 'first.js', source },
        { id: 8, url: 'second.js', source }
    ]);
    const getScript = vi.spyOn(scripts, 'get');
    const resolveFrame = vi.spyOn(dictionary, 'resolveLocationCallFrame');
    const events = [
        event({ scriptId: 7, start }),
        event({ scriptId: 7, start }),
        event({ scriptId: 7, start: otherStart }),
        event({ scriptId: 8, start }),
        event({ scriptId: 7, start })
    ];
    const count = dictionary.callFrames.length;

    try {
        const compilation = prepareCompilationEvents({ _events: events })!;

        resolveCompilationOwners(compilation, dictionary, scripts);

        assert.deepEqual(getScript.mock.calls, [[7], [8]]);
        assert.equal(resolveFrame.mock.calls.length, 3);
        assert.equal(dictionary.callFrames.length, count + 3);
        assert.equal(events[0].callFrame!.name, 'fresh');
        assert.equal(events[0].callFrame!.start, start);
        assert.equal(events[0].callFrame, events[1].callFrame);
        assert.equal(events[0].callFrame, events[4].callFrame);
        assert.equal(events[2].callFrame!.name, 'other');
        assert.notEqual(events[0].callFrame, events[3].callFrame);

        const locationCount = dictionary.locations.length;

        resolveCompilationOwners(compilation, dictionary, scripts);

        assert.equal(resolveFrame.mock.calls.length, 3);
        assert.equal(dictionary.locations.length, locationCount);
    } finally {
        getScript.mockRestore();
        resolveFrame.mockRestore();
    }
});

test.each([false, true])('profile links generated frames before source maps (CPU-only: %s)', async cpuOnly => {
    const { data, first, eventOnly } = profileFixture(cpuOnly);
    const stages: string[] = [];
    let finishParsing!: () => void;
    let parsingPending = true;
    const parsing = new Promise<void>(resolve => {
        finishParsing = resolve;
    });
    const prepareSources = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockImplementationOnce(async scripts => {
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
            assert.ok(stages.includes('prepare compilation attribution'));

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
        const profile = await createProfile(data, { work });
        const frame = first.callFrame!;

        assert.equal('compilationEvents' in profile, false);
        assert.equal(frame.name, 'known');
        assert.equal(frame.script!.url, 'generated.js');
        assert.ok(profile.callFrames.some(original => original.script?.originalFor === frame.script));
        assert.equal(eventOnly.callFrame!.name, 'compiledOnly');
        assert.ok(profile.callFrames.some(original => original.script?.originalFor === eventOnly.callFrame!.script));
        assert.ok(stages.indexOf('link compilation events') < stages.indexOf('process source maps'));
        assert.equal(stages.filter(name => name === 'link compilation events').length, 1);

        if (cpuOnly) {
            assert.equal(profile.memline, null);
        } else {
            const owner = profile.memline!.attributes.find(attribute => attribute.name === 'allocationOwner')!;
            const stage = profile.memline!.attributes.find(attribute => attribute.name === 'allocationCompilationStage')!;

            assert.deepEqual(Array.from(owner.values, index => owner.dict[index]), [null, frame, frame, null]);
            assert.deepEqual(Array.from(stage.values, index => stage.dict[index]), ['none', 'Compile', 'Compile', 'none']);
            assert.deepEqual([...profile.memline!.values], [8, 16, 32, 64]);
            assert.ok(stages.indexOf('create memline attributes') < stages.indexOf('parse script sources'));
            assert.ok(stages.indexOf('create location breakdown') < stages.indexOf('link compilation events'));
        }
    } finally {
        finishParsing();
        prepareSources.mockRestore();
    }
});

test('prepares exclusive event time without changing durations or input order', () => {
    const events = [
        event({ start: 0 }, { tm: 50, duration: 20 }),
        event({ start: 0 }, { tm: 0, duration: 100 }),
        event({ start: 0 }, { tm: 10, duration: 30 }),
        event({ start: 0 }, { tm: 60, duration: 0 })
    ];

    prepareCompilationEvents({ _events: events });

    assert.deepEqual(events.map(event => [event.tm, event.duration, event.selfTime]), [
        [50, 20, 20], [0, 100, 50], [10, 30, 30], [60, 0, 0]
    ]);

    prepareCompilationEvents({ _events: events });

    assert.equal(events.reduce((sum, event) => sum + event.selfTime, 0), 100);
});

test('setup publishes the original thread events with profile-local frame links', async () => {
    const input = { traceEvents: [1, 2].flatMap(tid => {
        const base = { pid: 1, tid, ts: 1000, ph: 'P', cat: 'profile' };

        return [
            { ...base, name: 'Profile', id: tid, args: { data: { startTime: 1000 } } },
            { ...base, name: 'ProfileChunk', id: tid, args: { data: {
                cpuProfile: { nodes: [
                    { id: 1, callFrame: { scriptId: '0', functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
                    { id: 2, callFrame: { scriptId: '7', functionName: 'known', url: `script-${tid}.js`, lineNumber: 0, columnNumber: 14, start: 14, end: 30 } }
                ], samples: [2, 2] }, timeDeltas: [10, 10], endTime: 1030
            } } },
            { ...base, name: 'Compile', ph: 'I', ts: 1001, cat: 'disabled-by-default-v8.compilation_allocations', args: { data: {
                scriptId: 7, line: 0, column: 14, start: 14, end: 30, startAllocationId: 10, endAllocationId: 20
            } } }
        ];
    }) };
    const marked = new Set();
    const markers = Object.fromEntries([
        'call-frame-codes', 'call-frame-position', 'call-frame', 'module', 'package', 'category', 'owner', 'script'
    ].map(name => [name, (entry: unknown) => marked.add(entry)]));

    const result = await prepare(input, {
        rejectData: reason => assert.fail(reason),
        markers,
        setWorkTitle: async () => {}
    } as Parameters<typeof prepare>[1]);

    assert.equal(result.profiles.length, 2);

    for (const profile of result.profiles) {
        const compiled = profile.thread.events[0] as CompilationEvent;

        assert.equal(profile.thread.events.length, 1);
        assert.equal(compiled.callFrame!.name, 'known');
        assert.equal(compiled.callFrame!.script!.url, `script-${profile.thread.tid}.js`);
        assert.ok(marked.has(compiled.callFrame));
    }

    const [first, second] = result.profiles.map(profile => profile.thread.events[0] as CompilationEvent);

    assert.notEqual(first.callFrame, second.callFrame);
});
