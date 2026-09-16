import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import prepare from './setup-prepare.mjs';
import { resolveScopeProfileLine, resolveScopeViewport } from './jora/profile.js';
import { viewportRange } from './jora/viewport.js';
import { subscribeSelectionSync } from './selection-sync.js';

async function prepareProfiles() {
    const input = [100, 120, 300].map((startTime, index) => ({
        startTime,
        endTime: startTime + 40,
        _pid: 1,
        _tid: index + 1,
        nodes: [
            { id: 1, callFrame: { scriptId: '0', url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2] },
            { id: 2, callFrame: { scriptId: '1', url: '/script.js', functionName: 'work', lineNumber: 0, columnNumber: 0 } }
        ],
        samples: [2, 2, 2],
        timeDeltas: [10, 10, 10]
    }));
    const markers = Object.fromEntries([
        'call-frame-codes', 'call-frame-position', 'call-frame', 'module', 'package', 'category', 'owner', 'script'
    ].map(name => [name, () => {}]));

    return prepare(input, {
        rejectData: reason => assert.fail(reason),
        markers,
        setWorkTitle: async () => {}
    } as Parameters<typeof prepare>[1]);
}

test('AC synchronizes independent requests across profile switches and detaches on unload', async () => {
    const data = await prepareProfiles();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.profiles.length, 3);
    assert.equal(new Set(data.profiles.map(profile => profile.thread)).size, 3);
    const actions: Map<string, (profile: typeof data.profiles[number]) => void> = new Map();
    const events: Map<string, () => void> = new Map();
    const model = {
        data,
        context: {
            data, primaryProfile: data.defaultProfile, primaryLineType: 'timeline' as const,
            primaryBreakdownKind: null, scopeProfile: null, scopeLine: null, scopeBreakdown: null
        },
        action: { define: (name: string, callback: (profile: typeof data.profiles[number]) => void) => actions.set(name, callback) },
        on: (name: string, callback: () => void) => events.set(name, callback),
        setContext(patch: object) {
            Object.assign(this.context, patch);
        }
    };
    runInNewContext(readFileSync(new URL('./init-core.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), {
        discovery: model,
        subscribeSelectionSync,
        allConvolutionRule: null, moduleConvolutionRule: null, topLevelConvolutionRule: null, profilePresenceConvolutionRule: null
    });
    events.get('data')!();
    const selection = data.profiles[0].timeline!.range.selection;
    const request = [{ start: 105, end: 115 }, { start: 135, end: 155 }];
    const viewport = resolveScopeViewport(null, model.context)!;
    assert.deepEqual(viewport, { start: 100, end: 340 });
    selection.setRanges(request);

    const updates = data.profiles.map(() => 0);
    data.profiles.forEach((profile, index) => profile.timeline!.breakdowns[0].populationFiltered.subscribe(() => updates[index]++));
    for (const index of [1, 2, 0, 2, 1]) {
        actions.get('selectProfile')!(data.profiles[index]);
        const line = resolveScopeProfileLine(null, model.context)!;
        assert.equal(line, data.profiles[index].timeline);
        assert.equal(line.range.selection === selection, index === 0);
        assert.deepEqual(line.range.selection.ranges, request);
        assert.deepEqual(resolveScopeViewport(null, model.context), viewport);
        assert.deepEqual(viewportRange(viewport, line).ranges, [{ start: 5, end: 15 }, { start: 35, end: 55 }]);
        assert.deepEqual(selection.ranges, request);
    }
    assert.deepEqual(updates, [0, 0, 0]);
    viewportRange(viewport, resolveScopeProfileLine(null, model.context)!).setRange(30, 40);
    assert.deepEqual(selection.ranges, [{ start: 130, end: 140 }]);
    assert.deepEqual(updates, [1, 1, 0]);
    const next = await prepareProfiles();
    assert.notEqual(next.profiles[0].timeline!.range.selection, selection);
    assert.ok(next.profiles.every(profile => profile.timeline!.range.ranges === null));

    const entries = Reflect.get(model.context, 'profiles') as { bucket: object; disabled: boolean }[];
    const bucket = entries[0].bucket;
    entries[1].bucket = {};
    selection.setRange(105, 115);
    assert.deepEqual(data.profiles[1].timeline!.range.selection.ranges, [{ start: 130, end: 140 }]);
    assert.deepEqual(data.profiles[2].timeline!.range.selection.ranges, [{ start: 105, end: 115 }]);
    entries[1].bucket = bucket;
    selection.setRange(105, 115);
    assert.deepEqual(data.profiles[1].timeline!.range.selection.ranges, [{ start: 105, end: 115 }]);
    entries[1].disabled = true;
    selection.setRange(130, 140);
    assert.deepEqual(data.profiles[1].timeline!.range.selection.ranges, [{ start: 105, end: 115 }]);
    data.profiles[1].timeline!.range.selection.setRange(150, 160);
    assert.deepEqual(selection.ranges, [{ start: 130, end: 140 }]);

    const previous = data.profiles[1].timeline!.range.selection.ranges;
    events.get('unloadData')!();
    selection.setRange(100, 110);
    assert.equal(data.profiles[1].timeline!.range.selection.ranges, previous);
});
