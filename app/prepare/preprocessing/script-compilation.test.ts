import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from '../dictionary.js';
import type { CpuProCompilationRecord } from '../types.js';
import { parseScriptSourceRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import { OriginalScriptsMap, ProfileScriptsMap } from './scripts.js';
import { processScriptCompilation } from './script-compilation.js';
import { linkThreadScripts } from './script-compilation.js';
import { createProfileSession } from '../profile-session.mjs';
import { extractFromChromiumPerformanceProfile } from '../formats/chromium-performance-profile.js';

function fixture(source = 'function outer() { function inner() {} return 1; }') {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 7, url: 'fixture.js', source }]);
    const script = scripts.get(7)!;
    const parsed = parseScriptSourceRanges(source, script.url, true);
    script.sourceMetrics = computeScriptSourceMetrics(source, parsed.ranges);
    script.functionRanges = parsed.ranges;

    return { script, scripts };
}

function record(name: string, start: number, end: number): CpuProCompilationRecord {
    return { name, scriptId: 7, start, end, tm: 0, duration: 1, line: null, column: null,
        functionName: null, allocationStart: null, allocationEnd: null, event: null, eventIndex: null, callFrame: null };
}

test('enclosing frame links, incomplete events and unknown stages cannot activate a different function', () => {
    const { script, scripts } = fixture();
    const [outer, inner] = script.functionRanges!;
    const records = [
        record('CompileFunction', inner.callFrameStart + 1, inner.end),
        { ...record('CompileFunction', outer.callFrameStart, outer.end), duration: null },
        record('UnknownStage', inner.callFrameStart, inner.end)
    ];

    const compilation = processScriptCompilation([...records, ...records], scripts).get(7)!;

    assert.deepEqual([...compilation.states], [0, 0, 0]);
    assert.deepEqual(compilation.unmatchedStarts, [inner.callFrameStart + 1]);
    assert.deepEqual(compilation.unknownStages, ['UnknownStage']);
});

test('local script IDs and separate thread event sets do not share compilation state', () => {
    const { script, scripts } = fixture();
    const range = script.functionRanges![0];
    scripts.set(8, script);
    const first = processScriptCompilation([
        record('CompileFunction', range.callFrameStart, range.end),
        { ...record('PreParse', range.callFrameStart, range.end), scriptId: 8 }
    ], scripts);
    const second = processScriptCompilation([record('ParseFunction', range.callFrameStart, range.end)], scripts);

    assert.equal(first.get(7)!.states[1], 3);
    assert.equal(first.get(8)!.states[1], 1);
    assert.equal(second.get(7)!.states[1], 2);
    assert.equal(first.get(7)!.states[1], 3);
    assert.equal('compilation' in script, false);
});

test.each(['CompileMaglev', 'MaglevConcurrentPrepare', 'CompileOptimized', 'CompileOptimizedOSR', 'Turbofan.OptimizeConcurrentPrepare'])(
    '%s is compiled evidence but not completed optimization', name => {
        const { script, scripts } = fixture();
        const range = script.functionRanges![0];
        const compilation = processScriptCompilation([record(name, range.callFrameStart, range.end)], scripts).get(7)!;

        assert.equal(compilation.states[1], 3);
        assert.deepEqual(compilation.unknownStages, []);
    }
);

test('streamed script lookup is recognized without claiming compilation', () => {
    const { script, scripts } = fixture();
    const compilation = processScriptCompilation([
        record('GetSharedFunctionInfoForStreamedScript', 0, script.source!.length)
    ], scripts).get(7)!;

    assert.ok(compilation.states.every(state => state === 0));
    assert.deepEqual(compilation.unknownStages, []);
});

test('thread script links retain local IDs and isolate events even when Dictionary shares source objects', () => {
    const source = 'function shared() {}';
    const base = { pid: 1, ts: 0, ph: 'P', cat: 'profile' };
    const raw = extractFromChromiumPerformanceProfile([1, 2].flatMap(tid => [
        { ...base, tid, id: String(tid), name: 'Profile', args: { data: { startTime: 0 } } },
        { ...base, tid, name: 'ScriptCatchup', args: { data: { scriptId: tid * 7, url: 'shared.js', sourceText: source } } },
        { ...base, tid, name: 'ScriptCatchup', args: { data: { scriptId: 100, url: `thread-${tid}.js`, sourceText: '' } } },
        { ...base, tid, name: tid === 1 ? 'CompileFunction' : 'PreParse', ph: 'X', dur: 1,
            cat: 'disabled-by-default-v8.compilation_allocations',
            args: { data: { scriptId: tid * 7, start: source.indexOf('('), end: source.length } } }
    ]));
    const before = structuredClone(raw.threads.map(thread => thread.scripts));
    const dictionary = new Dictionary();
    const originals = new OriginalScriptsMap(dictionary);
    const { profiles } = createProfileSession(raw, dictionary);
    const maps = profiles.map(entry => new ProfileScriptsMap(dictionary, originals, entry.profile._scripts));
    const shared = maps[0].get(7)!;
    const parsed = parseScriptSourceRanges(source, 'shared.js', true);
    shared.functionRanges = parsed.ranges;
    shared.sourceMetrics = computeScriptSourceMetrics(source, parsed.ranges);
    const original = maps[0].resolveOriginalScript('only-first.ts', '', shared);

    profiles.forEach((entry, index) => linkThreadScripts(entry.thread, maps[index]));
    linkThreadScripts(profiles[0].thread, maps[0]);

    const first = profiles[0].thread.scripts;
    const second = profiles[1].thread.scripts;
    assert.equal(first[0].id, 7);
    assert.equal(second[0].id, 14);
    assert.equal(first[0].script, second[0].script);
    assert.equal(first[0].compilation!.states[1], 3);
    assert.equal(second[0].compilation!.states[1], 1);
    assert.deepEqual(first.map(entry => entry.url), ['shared.js', 'thread-1.js']);
    assert.deepEqual(second.map(entry => entry.url), ['shared.js', 'thread-2.js']);
    assert.ok(first.every(entry => entry.script !== original));
    assert.equal('compilation' in shared, false);
    assert.deepEqual(raw.threads.map(thread => thread.scripts), before);
});
