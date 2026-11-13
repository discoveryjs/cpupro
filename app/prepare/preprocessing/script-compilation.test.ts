import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ProfileScriptsMap } from './scripts.js';
import { linkThreadScripts, prepareCompilationSubjects, processScriptCompilation } from './script-compilation.js';
import { createProfileSession } from '../profile-session.mjs';
import { extractFromChromiumPerformanceProfile } from '../formats/chromium-performance-profile.js';
import { Dictionary } from '../dictionary.js';
import { createCompilationRecord } from '../../../test/fixtures/compilation.js';
import { createScriptFixture, parseScriptFixture } from '../../../test/fixtures/scripts.js';

// Function compilation states: 0 untouched, 1 pre-parsed, 2 parsed, 3 compiled

const nestedFunctions = 'function outer() { function inner() {} return 1; }';

test('enclosing frame links, incomplete events and unknown stages cannot activate a different function', () => {
    const { script, scripts } = createScriptFixture(nestedFunctions);
    const [outer, inner] = script.functionRanges!;
    const records = [
        createCompilationRecord({
            name: 'CompileFunction',
            start: inner.callFrameStart + 1,
            end: inner.end
        }),
        createCompilationRecord({
            name: 'CompileFunction',
            start: outer.callFrameStart,
            end: outer.end,
            duration: null
        }),
        createCompilationRecord({ name: 'UnknownStage', start: inner.callFrameStart, end: inner.end })
    ];

    const compilation = processScriptCompilation(prepareCompilationSubjects([...records, ...records]), scripts).get(7)!;

    assert.deepEqual([...compilation.states], [0, 0, 0]);
    assert.deepEqual(compilation.unmatchedStarts, [inner.callFrameStart + 1]);
    assert.deepEqual(compilation.unknownStages, ['UnknownStage']);
});

test('local script IDs and separate thread event sets do not share compilation state', () => {
    const { script, scripts } = createScriptFixture(nestedFunctions);
    const range = script.functionRanges![0];

    scripts.set(8, script);

    const first = processScriptCompilation(prepareCompilationSubjects([
        createCompilationRecord({ name: 'CompileFunction', start: range.callFrameStart, end: range.end }),
        createCompilationRecord({
            name: 'PreParse',
            scriptId: 8,
            start: range.callFrameStart,
            end: range.end
        })
    ]), scripts);
    const second = processScriptCompilation(prepareCompilationSubjects([
        createCompilationRecord({ name: 'ParseFunction', start: range.callFrameStart, end: range.end })
    ]), scripts);

    assert.equal(first.get(7)!.states[1], 3);
    assert.equal(first.get(8)!.states[1], 1);
    assert.equal(second.get(7)!.states[1], 2);
    assert.equal(first.get(7)!.states[1], 3);
    assert.equal('compilation' in script, false);
});

test.each([
    'CompileMaglev',
    'MaglevConcurrentPrepare',
    'CompileOptimized',
    'CompileOptimizedOSR',
    'Turbofan.OptimizeConcurrentPrepare'
])('%s is compiled evidence but not completed optimization', name => {
    const { script, scripts } = createScriptFixture(nestedFunctions);
    const range = script.functionRanges![0];
    const compilation = processScriptCompilation(prepareCompilationSubjects([
        createCompilationRecord({ name, start: range.callFrameStart, end: range.end })
    ]), scripts).get(7)!;

    assert.equal(compilation.states[1], 3);
    assert.deepEqual(compilation.unknownStages, []);
});

test('streamed script lookup is recognized without claiming compilation', () => {
    const { script, scripts } = createScriptFixture(nestedFunctions);
    const compilation = processScriptCompilation(prepareCompilationSubjects([
        createCompilationRecord({
            name: 'GetSharedFunctionInfoForStreamedScript',
            start: 0,
            end: script.source!.length
        })
    ]), scripts).get(7)!;

    assert.ok(compilation.states.every(state => state === 0));
    assert.deepEqual(compilation.unknownStages, []);
});

test('whole-script stages take precedence while ambiguous function ranges remain unresolved', () => {
    const { script, scripts } = createScriptFixture('() => 1');
    const range = script.functionRanges![0];
    const records = [
        createCompilationRecord({ name: 'CompileCode', start: 0, end: script.source!.length }),
        createCompilationRecord({ name: 'PreParse', start: range.callFrameStart, end: range.end })
    ];

    assert.deepEqual([...processScriptCompilation(prepareCompilationSubjects(records), scripts).get(7)!.states], [3, 1]);

    script.functionRanges!.push({ ...range });

    const ambiguous = processScriptCompilation(prepareCompilationSubjects(records), scripts).get(7)!;

    assert.deepEqual([...ambiguous.states], [3, 0, 0]);
    assert.deepEqual(ambiguous.unmatchedStarts, [0]);
});

test('thread script links retain local IDs and isolate events even when Dictionary shares source objects', () => {
    const source = 'function shared() {}';
    const base = { pid: 1, ts: 0, ph: 'P', cat: 'profile' };
    const threadEvents = (tid: number, stage: string) => [
        {
            ...base,
            tid,
            id: String(tid),
            name: 'Profile',
            args: { data: { startTime: 0 } }
        },
        {
            ...base,
            tid,
            name: 'ScriptCatchup',
            args: { data: { scriptId: tid * 7, url: 'shared.js', sourceText: source } }
        },
        {
            ...base,
            tid,
            name: 'ScriptCatchup',
            args: { data: { scriptId: 100, url: `thread-${tid}.js`, sourceText: '' } }
        },
        {
            ...base,
            tid,
            name: stage,
            ph: 'X',
            dur: 1,
            cat: 'disabled-by-default-v8.compilation_allocations',
            args: {
                data: { scriptId: tid * 7, start: source.indexOf('('), end: source.length }
            }
        }
    ];
    const raw = extractFromChromiumPerformanceProfile([
        ...threadEvents(1, 'CompileFunction'),
        ...threadEvents(2, 'PreParse')
    ]);
    const before = structuredClone(raw.threads.map(thread => thread.scripts));
    const dictionary = new Dictionary();
    const { profiles } = createProfileSession(raw, dictionary);
    const maps = profiles.map(entry => new ProfileScriptsMap(dictionary, entry.profile._scripts));
    const shared = maps[0].get(7)!;

    parseScriptFixture(shared);

    for (let i = 0; i < profiles.length; i++) {
        linkThreadScripts(profiles[i].thread, maps[i]);
    }

    linkThreadScripts(profiles[0].thread, maps[0]);

    const first = profiles[0].thread.scripts;
    const second = profiles[1].thread.scripts;

    assert.equal(first[0].id, 7);
    assert.equal(second[0].id, 14);
    assert.equal(first[0].script, second[0].script);
    assert.equal(first[0].compilation!.states[1], 3);
    assert.equal(second[0].compilation!.states[1], 1);
    assert.deepEqual(first.map(entry => entry.url), ['shared.js', 'thread-1.js']);
    // a thread script keeps the id and url of the input script, not its source and source map
    assert.deepEqual(Object.keys(first[0]), ['id', 'url', 'script', 'compilation']);
    assert.deepEqual(second.map(entry => entry.url), ['shared.js', 'thread-2.js']);
    assert.equal('compilation' in shared, false);
    assert.deepEqual(raw.threads.map(thread => thread.scripts), before);
});

test('a compilation subject takes the most advanced state of its complete records', () => {
    const subjects = prepareCompilationSubjects([
        createCompilationRecord({ name: 'CompileFunction', start: 10 }),
        createCompilationRecord({ name: 'PreParse', start: 10 }),
        createCompilationRecord({ name: 'PreParse', start: 30 }),
        createCompilationRecord({ name: 'Turbofan.OptimizeCode', start: 30, duration: null })
    ]);

    assert.deepEqual(subjects.map(subject => [subject.subject, subject.state, subject.events]), [
        ['7:10', 'compiled', 2],
        ['7:30', 'pre-parsed', 2]
    ]);
});
