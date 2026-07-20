/* eslint-env node */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRuntime } from '../app/prepare/detect-runtime.js';

test('keeps the legacy V8 fallback when runtime metadata is absent', () => {
    assert.deepEqual(detectRuntime([], []), {
        engine: 'V8',
        code: 'unknown',
        name: 'Unknown'
    });
});

test('keeps the legacy Node.js runtime heuristic', () => {
    assert.deepEqual(detectRuntime([{ id: 1, name: 'node' }], []), {
        engine: 'V8',
        code: 'nodejs',
        name: 'Node.js'
    });
});

test('maps Firefox and Cynic runtimes to their engines', () => {
    assert.deepEqual(detectRuntime([], [], 'firefox'), {
        engine: 'SpiderMonkey',
        code: 'firefox',
        name: 'Firefox'
    });
    assert.deepEqual(detectRuntime([], [], 'cynic'), {
        engine: 'Cynic',
        code: 'cynic',
        name: 'Cynic'
    });
});

test('does not label an explicitly unknown Gecko runtime as V8', () => {
    assert.deepEqual(detectRuntime([], [], 'unknown'), {
        engine: 'Unknown',
        code: 'unknown',
        name: 'Unknown'
    });
});
