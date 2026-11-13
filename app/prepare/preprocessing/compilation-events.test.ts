import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import * as scriptFunctions from '../misc/script-function-resolution.js';
import { ProfileScriptsMap } from './scripts.js';
import { resolveCompilationCallFrames } from './compilation-events.js';
import { prepareCompilationSubjects } from './script-compilation.js';
import type { CpuProCompilationRecord } from '../types.js';
import { createCompilationRecord } from '../../../test/fixtures/compilation.js';
import { createScriptFixture } from '../../../test/fixtures/scripts.js';

const source = 'function outer() { const inner = () => 1; } class Empty {}';
// the runtime range of the arrow function `inner`
const innerStart = source.indexOf('() =>');
const innerEnd = source.indexOf(';');

// A truncated frame of `inner`, as a sampled frame can be, at the call frame position of `inner`
function sampleTruncatedInner(dictionary: Dictionary, scripts: ProfileScriptsMap) {
    return dictionary.resolveCallFrame({
        scriptId: 7,
        url: 'fixture.js',
        functionName: 'truncated',
        lineNumber: 0,
        columnNumber: innerStart,
        start: innerStart,
        end: innerEnd - 1
    }, scripts);
}

test('a function compilation resolves to the frame of its exact runtime range, not of its location', () => {
    const { dictionary, scripts, script } = createScriptFixture(source);
    const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
    const location = dictionary.resolveLocation(scriptFrame, script, innerStart);
    const record: CpuProCompilationRecord = createCompilationRecord({
        name: 'CompileIgnition',
        start: innerStart,
        end: innerEnd
    });

    resolveCompilationCallFrames(prepareCompilationSubjects([record]), dictionary, scripts);

    assert.equal(location.callFrame, scriptFrame);
    assert.equal(record.callFrame?.name, 'inner');
    assert.equal(record.callFrame?.start, innerStart);
    assert.equal(record.callFrame?.end, innerEnd);
});

test('a zero-length compilation at a class start resolves to the class, whose default constructor it compiles', () => {
    const { dictionary, scripts } = createScriptFixture(source);
    const start = source.indexOf('class');
    const record: CpuProCompilationRecord = createCompilationRecord({ name: 'CompileIgnition', start, end: start });

    resolveCompilationCallFrames(prepareCompilationSubjects([record]), dictionary, scripts);

    assert.equal(record.callFrame?.name, 'Empty');
    assert.equal(record.callFrame?.start, start);
    assert.equal(record.callFrame?.end, source.length);
});

test.each([
    {
        name: 'ParseProgram',
        source: 'class Whole {}',
        frame: '(script)'
    },
    {
        name: 'CompileCode',
        source: 'class Whole {}',
        frame: '(script)'
    },
    {
        name: 'CompileIgnition',
        source: 'class Whole {}',
        frame: 'Whole'
    },
    {
        name: 'CompileIgnition',
        source,
        frame: '(script)'
    }
])('a $name compilation of the whole $source resolves to $frame', row => {
    const { dictionary, scripts } = createScriptFixture(row.source);
    const record: CpuProCompilationRecord = createCompilationRecord({
        name: row.name,
        start: 0,
        end: row.source.length
    });

    resolveCompilationCallFrames(prepareCompilationSubjects([record]), dictionary, scripts);

    assert.equal(record.callFrame?.name, row.frame);
});

test.each([
    { functionName: 'recorded', frame: 'recorded' },
    { functionName: null, frame: '(anonymous)' }
])('a compilation inside a function gets a frame of its own range, named by its function name $functionName', row => {
    const { dictionary, scripts } = createScriptFixture(source);
    const record: CpuProCompilationRecord = createCompilationRecord({
        name: 'CompileIgnition',
        start: innerStart + 1,
        end: innerEnd,
        functionName: row.functionName
    });

    resolveCompilationCallFrames(prepareCompilationSubjects([record]), dictionary, scripts);

    assert.equal(record.callFrame?.name, row.frame);
    assert.equal(record.callFrame?.start, innerStart + 1);
    assert.equal(record.callFrame?.end, innerEnd);
});

test('a compilation ending at the script end inside a class is not a compilation of the whole script', () => {
    const { dictionary, scripts } = createScriptFixture(source);
    const start = source.indexOf('class') + 1;
    const record: CpuProCompilationRecord = createCompilationRecord({
        name: 'CompileIgnition',
        start,
        end: source.length
    });

    resolveCompilationCallFrames(prepareCompilationSubjects([record]), dictionary, scripts);

    assert.equal(record.callFrame?.name, '(anonymous)');
    assert.equal(record.callFrame?.start, start);
});

test('a compilation takes a sampled frame of its exact range, and sets only call frames of its records', () => {
    const source = 'const run = function() {};';
    const { dictionary, scripts } = createScriptFixture(source);
    const start = source.indexOf('(');
    const sampled = dictionary.resolveCallFrame({
        scriptId: 7,
        url: 'fixture.js',
        functionName: 'runtimeName',
        lineNumber: 0,
        columnNumber: start,
        start,
        end: source.length - 1
    }, scripts);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({ name: 'CompileIgnition', start, end: source.length - 1 }),
        createCompilationRecord({ name: 'Compile', start: start + 1, end: source.length - 1 })
    ];
    const before = structuredClone(records);
    const frameCount = dictionary.callFrames.length;

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.equal(records[0].callFrame, sampled);
    assert.notEqual(records[1].callFrame, sampled);
    assert.equal(dictionary.callFrames.length, frameCount + 1);
    assert.deepEqual(records.map(record => ({ ...record, callFrame: null })), before);
});

test('beside a truncated sampled frame, an exact-range compilation is named by its record, then its function', () => {
    const { dictionary, scripts } = createScriptFixture(source);
    const truncated = sampleTruncatedInner(dictionary, scripts);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({
            name: 'CompileIgnition',
            start: innerStart,
            end: innerEnd,
            functionName: 'recorded'
        }),
        createCompilationRecord({ name: 'CompileIgnition', start: innerStart, end: innerEnd })
    ];

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.deepEqual(records.map(record => record.callFrame?.name), ['recorded', 'inner']);
    assert.deepEqual(records.map(record => record.callFrame?.end), [innerEnd, innerEnd]);
    assert.notEqual(records[0].callFrame, truncated);
});

test.each([
    {
        name: 'without a script id',
        fields: { scriptId: null }
    },
    {
        name: 'of an unknown script',
        fields: { scriptId: 99 }
    },
    {
        name: 'without a start',
        fields: { start: null }
    },
    {
        name: 'without an end',
        fields: { end: null }
    },
    {
        name: 'with a negative start',
        fields: { start: -1 }
    },
    {
        name: 'ending before its start',
        fields: { start: innerEnd, end: innerStart }
    }
])('a compilation $name has no call frame and does not stop resolution of later records', row => {
    const { dictionary, scripts } = createScriptFixture(source);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({
            name: 'CompileIgnition',
            start: innerStart,
            end: innerEnd,
            ...row.fields
        }),
        createCompilationRecord({ name: 'CompileIgnition', start: innerStart, end: innerEnd })
    ];

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.equal(records[0].callFrame, null);
    assert.equal(records[1].callFrame?.name, 'inner');
});

test('in a script without source, a compilation takes its position from the record, the script start at 0', () => {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [
        { id: 7, url: 'fixture.js', source },
        { id: 8, url: 'missing.js', source: null! }
    ]);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({
            scriptId: 8,
            start: 5,
            end: 9,
            line: 2,
            column: 3
        }),
        createCompilationRecord({
            scriptId: 8,
            start: 0,
            end: 9,
            line: 2,
            column: 3
        }),
        createCompilationRecord({ scriptId: 8, start: 5, end: 9 }),
        createCompilationRecord({ name: 'CompileIgnition', start: innerStart, end: innerEnd })
    ];

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.deepEqual([records[0].callFrame?.line, records[0].callFrame?.column], [2, 3]);
    assert.deepEqual([records[1].callFrame?.line, records[1].callFrame?.column], [0, 0]);
    // an unknown position gives no exact identity
    assert.equal(records[2].callFrame, null);
    assert.equal(records[3].callFrame?.name, 'inner');
});

test.each([
    {
        first: 'ParseProgram',
        second: 'CompileIgnition',
        frames: ['(script)', 'Whole']
    },
    {
        first: 'CompileIgnition',
        second: 'ParseProgram',
        frames: ['Whole', '(script)']
    },
    {
        first: 'CompileCode',
        second: 'ParseProgram',
        frames: ['(script)', '(script)']
    }
])('at the script start, a $second compilation after $first shares its frame only with the same kind', row => {
    const source = 'class Whole {}';
    const { dictionary, scripts } = createScriptFixture(source);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({ name: row.first, start: 0, end: source.length }),
        createCompilationRecord({ name: row.second, start: 0, end: source.length })
    ];

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.deepEqual(records.map(record => record.callFrame?.name), row.frames);
});

test('a compilation at the start of a resolved one with another end gets its own frame', () => {
    const { dictionary, scripts } = createScriptFixture(source);
    const records: CpuProCompilationRecord[] = [
        createCompilationRecord({ name: 'CompileIgnition', start: innerStart, end: innerEnd }),
        createCompilationRecord({ name: 'CompileIgnition', start: innerStart, end: innerEnd - 1 })
    ];

    resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);

    assert.equal(records[0].callFrame?.name, 'inner');
    assert.equal(records[1].callFrame?.end, innerEnd - 1);
});

test('repeated compilation stages resolve source coordinates once per identity', () => {
    const source = 'function run() {}';
    const { dictionary, scripts } = createScriptFixture(source);
    const start = source.indexOf('(');
    const records: CpuProCompilationRecord[] = [];

    for (let i = 0; i < 10000; i++) {
        const name = i % 2 ? 'CompileIgnition' : 'PreParse';

        records.push(createCompilationRecord({ name, start, end: source.length }));
    }

    const positions = vi.spyOn(scriptFunctions, 'getScriptLineColumnFromOffset');

    try {
        resolveCompilationCallFrames(prepareCompilationSubjects(records), dictionary, scripts);
        assert.equal(positions.mock.calls.length, 1);
        assert.ok(records[0].callFrame);
        assert.ok(records.every(record => record.callFrame === records[0].callFrame));
    } finally {
        positions.mockRestore();
    }
});
