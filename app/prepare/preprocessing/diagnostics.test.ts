import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDiagnosticsCollector } from '../diagnostics.js';
import { Dictionary } from '../dictionary.js';
import { parseScriptSourceRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import { processCallFrameCodes } from './call-frame-codes.js';
import { linkThreadScripts } from './script-compilation.js';
import { OriginalScriptsMap, ProfileScriptsMap, scriptFromScriptId } from './scripts.js';
import { processCodePositionTables } from '../formats/v8-log-processed/positions.js';
import type { CpuProThread, V8CpuProfileCallFrameCodes } from '../types.js';
import type { V8LogCode } from '../formats/v8-log-processed/types.js';

function createScriptsMap() {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const dictionary = new Dictionary(diagnose);
    const scripts = new ProfileScriptsMap(
        dictionary,
        new OriginalScriptsMap(dictionary),
        [{ id: 7, url: 'fixture.js', source: 'const run = () => 1;' }],
        diagnose
    );

    return { diagnostics, dictionary, scripts };
}

test('reports used script ids that are not found, except the absent script id 0', () => {
    const { diagnostics, scripts } = createScriptsMap();

    scripts.getScriptsById([7, 99, 0, '0']);

    assert.deepEqual(diagnostics, [
        { level: 'warn', scope: [], message: 'Script not found for id', details: { scriptId: 99 } }
    ]);
});

test('reports a normalized script id only when it already belongs to a script', () => {
    const { diagnostics, scripts } = createScriptsMap();

    // a stringified id is normalized to 7, which is a registered script
    const existing = scriptFromScriptId(':7', 'fixture.js', scripts);
    // an unknown URL gets a fresh negative id: nothing to report
    scriptFromScriptId('http://example.com/other.js', 'other.js', scripts);

    assert.equal(existing, scripts.get(7));
    assert.deepEqual(diagnostics, [
        {
            level: 'warn',
            scope: [],
            message: 'Script already exists for normalized script id',
            details: { scriptId: 7, originalScriptId: ':7' }
        }
    ]);
});

test('reports a script with compilation data that is missing in the thread scripts', () => {
    const { diagnostics, scripts } = createScriptsMap();
    const script = scripts.get(7)!;
    const parsed = parseScriptSourceRanges(script.source!, script.url, true);
    const thread = { scripts: [] } as unknown as CpuProThread;

    script.sourceMetrics = computeScriptSourceMetrics(script.source, parsed.ranges);
    script.functionRanges = parsed.ranges;
    thread.compilations = [{
        name: 'CompileFunction',
        scriptId: 7,
        start: 0,
        end: 5,
        tm: 0,
        duration: 1,
        line: null,
        column: null,
        functionName: null,
        allocationStart: null,
        allocationEnd: null,
        event: null,
        eventIndex: null,
        callFrame: null
    }];
    linkThreadScripts(thread, scripts);

    assert.deepEqual(diagnostics, [
        {
            level: 'warn',
            scope: [],
            message: 'Script is missing in thread scripts',
            details: { scriptId: 7, url: 'fixture.js' }
        }
    ]);
});

test('reports a conflicting package name for an origin once and keeps the first name', () => {
    const { diagnostics, dictionary } = createScriptsMap();

    dictionary.setPackageNameForOrigin('example.com', 'First');
    dictionary.setPackageNameForOrigin('example.com', 'First');
    dictionary.setPackageNameForOrigin('example.com', 'Second');

    assert.deepEqual(diagnostics, [
        {
            level: 'warn',
            scope: [],
            message: 'Package name for origin is already set, new name ignored',
            details: { origin: 'example.com', packageName: 'First', newPackageName: 'Second' }
        }
    ]);
});

test('reports function call frame codes of a call frame without a script', () => {
    const { dictionary } = createScriptsMap();
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const callFrameIndex = dictionary.resolveCallFrameIndex({
        scriptId: 0,
        url: '',
        functionName: 'noScript',
        lineNumber: -1,
        columnNumber: -1
    }, null as never);

    processCallFrameCodes(
        [{ callFrame: 0, codes: [] }] as V8CpuProfileCallFrameCodes[],
        Uint32Array.of(callFrameIndex),
        dictionary.callFrames,
        0,
        0,
        diagnose
    );

    assert.deepEqual(diagnostics.map(({ message, details }) => [message, details?.name]), [
        ['Script function has no script', 'noScript']
    ]);
});

test('reports v8 log codes with unresolvable inlined functions and skips their positions', () => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const code = (fns: (number | null)[], inlined: string): V8LogCode => ({
        name: 'broken',
        type: 'JS',
        kind: 'Ignition',
        func: 0,
        source: { positions: 'C0O1', inlined, fns }
    } as unknown as V8LogCode);
    const tables = processCodePositionTables([
        code([null], 'F0O1'),
        code([5], 'F1O1'),
        code([0], 'F0O1')
    ], [0, 1, 2], diagnose);

    assert.deepEqual(tables.map(table => table !== null), [false, false, true]);
    assert.deepEqual(diagnostics.map(({ level, message, details }) => [level, message, details]), [
        ['error', 'Ignoring positions: undefined inlined function', {
            name: 'broken', func: 0, fns: [null]
        }],
        ['error', 'Ignoring positions: unresolved inlined function', {
            name: 'broken', func: 0, fns: [5]
        }]
    ]);
});
