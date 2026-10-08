import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createDiagnosticsCollector, diagnoseToConsole, printDiagnostic } from './diagnostics.js';

test('collector accumulates diagnostics in report order', () => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();

    diagnose('warn', 'First', { pid: 1 });
    diagnose('error', 'Second');

    assert.deepEqual(diagnostics, [
        { level: 'warn', scope: [], message: 'First', details: { pid: 1 } },
        { level: 'error', scope: [], message: 'Second' }
    ]);
});

test('withScope marks messages with nested owners and leaves the parent unchanged', () => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const session = diagnose.withScope('Session 1');
    const format = session.withScope('cpuprofile');

    format('warn', 'Inner');
    session('warn', 'Middle');
    diagnose('warn', 'Outer');

    assert.deepEqual(diagnostics.map(({ scope, message }) => [scope, message]), [
        [['Session 1', 'cpuprofile'], 'Inner'],
        [['Session 1'], 'Middle'],
        [[], 'Outer']
    ]);
});

test('onReport is called for every diagnostic in addition to accumulation', () => {
    const reported: unknown[] = [];
    const { diagnostics, diagnose } = createDiagnosticsCollector({
        onReport: diagnostic => reported.push(diagnostic)
    });

    diagnose.withScope('format')('warn', 'Message');

    assert.equal(reported.length, 1);
    assert.deepEqual(reported, diagnostics);
});

test('printDiagnostic writes to the console by level with a scope prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        printDiagnostic({
            level: 'warn',
            scope: ['A', 'B'],
            message: 'Warning',
            details: { tid: 2 }
        });
        printDiagnostic({ level: 'error', scope: [], message: 'Failure' });

        assert.deepEqual(warn.mock.calls, [['[A / B] Warning', { tid: 2 }]]);
        assert.deepEqual(error.mock.calls, [['Failure']]);
    } finally {
        warn.mockRestore();
        error.mockRestore();
    }
});

test('default diagnose prints and supports scopes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        diagnoseToConsole.withScope('format')('warn', 'Warning');

        assert.deepEqual(warn.mock.calls, [['[format] Warning']]);
    } finally {
        warn.mockRestore();
    }
});
