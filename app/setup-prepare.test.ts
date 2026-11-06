import assert from 'node:assert/strict';
import { test } from 'vitest';
import prepare from './setup-prepare.mjs';
import { resolveScopeProfileLine, resolveScopeViewport } from './jora/profile.js';
import { viewportRange } from './jora/viewport.js';
import { subscribeSelectionSync } from './selection-sync.js';
import { evaluateModule } from '../test/helpers/evaluate-module.js';

type Data = Awaited<ReturnType<typeof prepare>>;
type Profile = Data['profiles'][number];

const cpuNodes = [
    { id: 1, callFrame: { scriptId: '0', url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2] },
    { id: 2, callFrame: { scriptId: '1', url: '/script.js', functionName: 'work', lineNumber: 0, columnNumber: 0 } }
];
const markers = Object.fromEntries([
    'call-frame-codes', 'call-frame-position', 'call-frame', 'module', 'package', 'category', 'owner', 'script'
].map(name => [name, () => {}]));

function prepareData(input: unknown) {
    return prepare(input, {
        rejectData: reason => assert.fail(reason),
        markers,
        setWorkTitle: async () => {}
    } as Parameters<typeof prepare>[1]);
}

// Three CPU profiles of different threads, starting at 100, 120 and 300
function prepareProfiles() {
    return prepareData([100, 120, 300].map((startTime, index) => ({
        startTime,
        endTime: startTime + 40,
        _pid: 1,
        _tid: index + 1,
        nodes: cpuNodes,
        samples: [2, 2, 2],
        timeDeltas: [10, 10, 10]
    })));
}

// Runs the core initialization against a minimal model and loads prepared profiles
async function initCore() {
    const data = await prepareProfiles();
    const actions: Map<string, (profile: Profile) => void> = new Map();
    const events: Map<string, () => void> = new Map();
    const model = {
        data,
        context: {
            data, primaryProfile: data.defaultProfile, primaryLineType: 'timeline' as const,
            primaryBreakdownKind: null, scopeProfile: null, scopeLine: null, scopeBreakdown: null
        },
        action: { define: (name: string, callback: (profile: Profile) => void) => actions.set(name, callback) },
        on: (name: string, callback: () => void) => events.set(name, callback),
        setContext(patch: object) {
            Object.assign(this.context, patch);
        }
    };

    evaluateModule(new URL('./init-core.mjs', import.meta.url), {
        discovery: model,
        subscribeSelectionSync,
        allConvolutionRule: null, moduleConvolutionRule: null, topLevelConvolutionRule: null, profilePresenceConvolutionRule: null
    });
    events.get('data')!();

    const profileEntries = Reflect.get(model.context, 'profiles') as { bucket: object; disabled: boolean }[];

    return { data, model, actions, events, profileEntries, selection: data.profiles[0].timeline!.range.selection };
}

test('a selection request follows profile switches and recomputes only overlapping profiles', async () => {
    const { data, model, actions, selection } = await initCore();
    const request = [{ start: 105, end: 115 }, { start: 135, end: 155 }];
    const viewport = resolveScopeViewport(null, model.context)!;
    const updates = data.profiles.map(() => 0);

    assert.equal(data.sessions.length, 1);
    assert.equal(new Set(data.profiles.map(profile => profile.thread)).size, 3);
    assert.deepEqual(viewport, { start: 100, end: 340 });

    selection.setRanges(request);
    for (const [index, profile] of data.profiles.entries()) {
        profile.timeline!.breakdowns[0].populationFiltered.subscribe(() => updates[index]++);
    }

    for (const index of [1, 2, 0, 2, 1]) {
        actions.get('selectProfile')!(data.profiles[index]);
        const line = resolveScopeProfileLine(null, model.context)!;

        assert.equal(line, data.profiles[index].timeline);
        assert.equal(line.range.selection === selection, index === 0);
        assert.deepEqual(line.range.selection.ranges, request);
        assert.deepEqual(resolveScopeViewport(null, model.context), viewport);
        assert.deepEqual(viewportRange(viewport, line).ranges, [{ start: 5, end: 15 }, { start: 35, end: 55 }]);
    }
    assert.deepEqual(selection.ranges, request);
    assert.deepEqual(updates, [0, 0, 0]);

    // The third profile starts at 300 and does not overlap the new request
    viewportRange(viewport, resolveScopeProfileLine(null, model.context)!).setRange(30, 40);
    assert.deepEqual(selection.ranges, [{ start: 130, end: 140 }]);
    assert.deepEqual(updates, [1, 1, 0]);
});

test('a selection request reaches only enabled profiles of the same bucket', async () => {
    const { data, profileEntries, selection } = await initCore();
    const second = data.profiles[1].timeline!.range.selection;
    const third = data.profiles[2].timeline!.range.selection;
    const bucket = profileEntries[0].bucket;

    profileEntries[1].bucket = {};
    selection.setRange(105, 115);
    assert.equal(second.ranges, null);
    assert.deepEqual(third.ranges, [{ start: 105, end: 115 }]);

    // A repeated request synchronizes a profile that rejoined the bucket
    profileEntries[1].bucket = bucket;
    selection.setRange(105, 115);
    assert.deepEqual(second.ranges, [{ start: 105, end: 115 }]);

    profileEntries[1].disabled = true;
    selection.setRange(130, 140);
    assert.deepEqual(second.ranges, [{ start: 105, end: 115 }]);
    second.setRange(150, 160);
    assert.deepEqual(selection.ranges, [{ start: 130, end: 140 }]);
});

test('unloading detaches synchronization and new data starts unrestricted', async () => {
    const { data, events, selection } = await initCore();
    const second = data.profiles[1].timeline!.range.selection;

    selection.setRange(105, 115);
    events.get('unloadData')!();
    selection.setRange(100, 110);
    assert.deepEqual(second.ranges, [{ start: 105, end: 115 }]);

    const next = await prepareProfiles();
    assert.ok(next.profiles.every(profile => profile.timeline!.range.ranges === null));
});

test.each([
    { isolate: undefined, ids: ['first'] },
    { isolate: 'shared', ids: ['first', 'second'] }
])('setup passes thread compilations without a capture gate: $isolate', async ({ isolate, ids }) => {
    const base = { pid: 1, tid: 2, ts: 100, ph: 'P', cat: 'profile' };
    const data = await prepareData({
        traceEvents: [
            ...ids.flatMap((id, index) => [
                { ...base, id, name: 'Profile', args: { data: { startTime: 100 + index * 100, isolate } } },
                { ...base, id, name: 'ProfileChunk', args: { data: {
                    endTime: 140 + index * 100,
                    cpuProfile: { nodes: cpuNodes, samples: [2, 2, 2] },
                    timeDeltas: [10, 10, 10]
                } } }
            ]),
            { ...base, name: 'Compile', cat: 'disabled-by-default-v8.compilation_allocations', ph: 'X', ts: 110, dur: 5,
                args: { data: { isolate, scriptId: 1, start: 0, end: 10 } } }
        ]
    });
    const thread = data.profiles[0].thread;

    assert.equal(data.profiles.length, ids.length);
    assert.equal(thread.compilations!.length, 1);
    assert.equal(thread.compilations![0].event, thread.events[0]);
    assert.equal(thread.compilations![0].callFrame!.script!.url, '/script.js');

    for (const profile of data.profiles) {
        assert.equal(profile.thread, thread);
        assert.equal('compilation' in profile, false);
        assert.equal(profile.memline?.attributes.find(attribute => attribute.name === 'allocationOwner'), undefined);
    }
});
