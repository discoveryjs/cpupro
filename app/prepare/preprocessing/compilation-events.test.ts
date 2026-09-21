import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { createWorkHandler } from '../misc/work.js';
import prepare from '../../setup-prepare.mjs';
import { OriginalScriptsMap, ProfileScriptsMap } from './scripts.js';
import { processCompilationEvents, type CompilationEvent } from './compilation-events.js';

function event(data: { scriptId: number; start: number }): CompilationEvent {
    return {
        name: 'Compile', cat: 'disabled-by-default-v8.compilation_allocations',
        tm: 100, duration: 10, eventId: null, sampleTraceId: null,
        data: { data }
    } as CompilationEvent;
}

test('links compilation events to existing locations and preserves event references', () => {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{
        id: 7, url: 'generated.js', source: '', lineOffset: 4, columnOffset: 50
    }]);
    const frame = dictionary.callFrames[dictionary.resolveCallFrameIndex({
        scriptId: 7, url: 'generated.js', functionName: 'known', lineNumber: 4, columnNumber: 64, start: 14, end: 30
    }, scripts, true)];
    const data = { scriptId: 7, line: 4, column: 64, start: 14, end: 30, startAllocationId: 1, endAllocationId: 2 };
    const first = event(data);
    const second = event(data);
    const missing = event({ scriptId: 8, start: 14 });
    const unrelated = { ...first, cat: 'other' };
    processCompilationEvents([unrelated, first, second, missing], dictionary, scripts);

    assert.equal(first.callFrame, frame);
    assert.equal(second.callFrame, frame);
    assert.equal(missing.callFrame, null);
    assert.equal(first.data.data, data);
    assert.equal('callFrame' in unrelated, false);
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
    processCompilationEvents([first], dictionary, firstScripts);
    processCompilationEvents([second], dictionary, secondScripts);

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
        { ...event({ scriptId: 8, start }), cat: 'unrelated' },
        event({ scriptId: 7, start: otherStart }),
        event({ scriptId: 8, start }),
        event({ scriptId: 7, start })
    ];
    const count = dictionary.callFrames.length;

    try {
        processCompilationEvents(events, dictionary, scripts);
        assert.deepEqual(getScript.mock.calls, [[7], [8], [7]]);
        assert.equal(resolveFrame.mock.calls.length, 3);
        assert.equal(dictionary.callFrames.length, count + 3);
        assert.equal(events[0].callFrame!.name, 'fresh');
        assert.equal(events[0].callFrame!.start, start);
        assert.equal(events[0].callFrame, events[1].callFrame);
        assert.equal(events[0].callFrame, events[5].callFrame);
        assert.equal(events[3].callFrame!.name, 'other');
        assert.notEqual(events[0].callFrame, events[4].callFrame);
        const locationCount = dictionary.locations.length;
        processCompilationEvents(events, dictionary, scripts);
        assert.equal(resolveFrame.mock.calls.length, 3);
        assert.equal(dictionary.locations.length, locationCount);
    } finally {
        getScript.mockRestore();
        resolveFrame.mockRestore();
    }
});

test('profile links generated frames before source maps', async () => {
    const input = () => ({
        startTime: 1000, endTime: 1040,
        nodes: [
            { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2] },
            { id: 2, callFrame: { scriptId: 7, url: 'generated.js', functionName: 'known', lineNumber: 0, columnNumber: 14, start: 14, end: 30 } }
        ],
        samples: [2, 2, 2], timeDeltas: [10, 10, 10], _samplePositions: [15, 15, 15],
        _scripts: [{ id: 7, url: 'generated.js', source: '', sourceMap: {
            version: '3', file: 'generated.js', sources: ['original.js'], names: [], mappings: 'AAAA', sourcesContent: ['']
        } }]
    });
    const first = event({ scriptId: 7, start: 14 });
    const stages: string[] = [];
    const profile = await createProfile(input(), {
        events: [first],
        work: createWorkHandler(async ({ name }, task) => {
            stages.push(name);
            return task();
        })
    });
    const frame = first.callFrame!;
    assert.equal('compilationEvents' in profile, false);
    assert.equal(frame.name, 'known');
    assert.equal(frame.script!.url, 'generated.js');
    assert.ok(profile.callFrames.some(original => original.script?.originalFor === frame.script));
    assert.ok(stages.indexOf('link compilation events') < stages.indexOf('process source maps'));
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
        rejectData: reason => assert.fail(reason), markers, setWorkTitle: async () => {}
    } as Parameters<typeof prepare>[1]);

    assert.equal(result.profiles.length, 2);
    for (const profile of result.profiles) {
        assert.equal(profile.thread.events.length, 1);
        const compiled = profile.thread.events[0] as CompilationEvent;
        assert.equal(compiled.callFrame!.name, 'known');
        assert.equal(compiled.callFrame!.script!.url, `script-${profile.thread.tid}.js`);
        assert.ok(marked.has(compiled.callFrame));
    }
    const [first, second] = result.profiles.map(profile => profile.thread.events[0] as CompilationEvent);
    assert.notEqual(first.callFrame, second.callFrame);
});
