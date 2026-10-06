import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from '../prepare/dictionary.js';
import type { CpuProCompilationRecord } from '../prepare/types.js';
import { parseScriptSourceRanges } from '../prepare/misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../prepare/misc/source-text-metrics.js';
import { OriginalScriptsMap, ProfileScriptsMap } from '../prepare/preprocessing/scripts.js';
import { processScriptCompilation } from '../prepare/preprocessing/script-compilation.js';
import { scriptSourceSummary } from './script-compilation.js';

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

test('compilation states use exact source identities and exclusive byte contributions', () => {
    const { script, scripts } = fixture();
    const [outer, inner] = script.functionRanges!;
    const records = [
        record('CompileCode', 0, script.source!.length),
        record('CompileFunction', outer.callFrameStart, outer.end),
        record('PreParse', inner.callFrameStart, inner.end)
    ];

    const compilation = processScriptCompilation(records, scripts).get(7)!;
    const summary = scriptSourceSummary(script, compilation);

    assert.deepEqual([...compilation.states], [3, 3, 1]);
    assert.equal(summary.functions, 2);
    assert.equal(summary.compiledBytes, script.source!.length - inner.selfSize);
    assert.equal(summary.stateSizes!.reduce((sum, size) => sum + size, 0), summary.byteLength);
    assert.equal(summary.unmatched, 0);

    const optimized = processScriptCompilation([
        ...records, record('FinalizeMaglevCompilationJob', inner.callFrameStart, inner.end), ...records
    ], scripts).get(7)!;

    assert.deepEqual([...optimized.states], [3, 3, 4]);
    assert.deepEqual([...compilation.states], [3, 3, 1]);
    assert.equal(scriptSourceSummary(script, optimized).compiledBytes, script.sourceMetrics!.byteLength);
});

test('unknown coverage differs from unobserved code, and two-byte payload is weighted for the whole script', () => {
    const { script, scripts } = fixture('function run() { return "\u0100"; }');
    const range = script.functionRanges![0];

    assert.equal(scriptSourceSummary(script).compiledBytes, null);
    const compilation = processScriptCompilation([record('ParseFunction', range.callFrameStart, range.end)], scripts).get(7)!;

    assert.equal(scriptSourceSummary(script, compilation).compiledBytes, 0);
    assert.equal(scriptSourceSummary(script, compilation).stateSizes![2], range.selfSize * 2);
    assert.equal(scriptSourceSummary(script).byteLength, script.source!.length * 2);
});

test('observed compiled bytes use script-wide encoding for own sizes even when Unicode is only in an unobserved nested function', () => {
    const { script, scripts } = fixture('function outer() { function inner() { return "\u044f\ud83d\ude00"; } return 1; }');
    const [outer, inner] = script.functionRanges!;
    const compilation = processScriptCompilation([
        record('CompileCode', 0, script.source!.length),
        record('CompileFunction', outer.callFrameStart, outer.end)
    ], scripts).get(7)!;

    const summary = scriptSourceSummary(script, compilation);

    assert.equal(script.sourceMetrics!.bytesPerChar, 2);
    assert.equal(script.sourceMetrics!.nonLatin1CodeUnits, 3);
    assert.equal(summary.compiledBytes, (script.source!.length - inner.selfSize) * 2);
    assert.equal(summary.stateSizes![0], inner.selfSize * 2);
});

test('missing and failed parsing never report zero source sizes as known values', () => {
    const { script } = fixture();
    script.sourceMetrics = null;
    script.functionRanges = null;

    assert.equal(scriptSourceSummary(script).functions, null);
    assert.equal(scriptSourceSummary(script).byteLength, null);
    script.sourceMetrics = { byteLength: 10, bytesPerChar: 1, nonLatin1CodeUnits: 0, surrogatePairs: 0, selfSize: null };
    assert.equal(scriptSourceSummary(script).compiledBytes, null);
    assert.equal(scriptSourceSummary(script).stateSizes, null);
});
