import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, resolveScopeViewport } from './profile.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { methods as viewportMethods } from './viewport.js';
import { RangeSelection } from '../prepare/computations/range.js';

const query = jora.setup({ methods: { ...methods, ...viewportMethods } });

function createContext() {
    const timeline = {
        type: 'timeline', kind: 'time', axisStart: 120, axisEnd: 180,
        range: new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: 60 }, 120)
    };
    const memline = {
        type: 'memline', kind: 'memory',
        range: new RangeSelection({ name: 'bytes', unit: 'bytes' }).view({ start: 0, end: 500 })
    };
    const primaryProfile = { lines: [timeline, memline], timeline, memline };

    return {
        primaryProfile, primaryLineType: 'timeline',
        data: { profiles: [primaryProfile, { timeline: { axisStart: 100, axisEnd: 200 } }] }
    } as unknown as Parameters<typeof resolveScopeViewport>[1];
}

test('derives the default viewport from the resolved line, not the query data', () => {
    const context = createContext();
    for (const data of [{}, { viewport: { start: 0, end: 10 } }, { line: {} }]) {
        assert.deepEqual(query('scopeViewport()')(data, context), { start: 100, end: 200 });
    }
    context.primaryLineType = 'memline';
    assert.deepEqual(resolveScopeViewport(null, context), { start: 0, end: 500 });
    context.scopeLine = context.primaryProfile!.timeline;
    assert.deepEqual(resolveScopeViewport(null, context), { start: 100, end: 200 });
    const otherProfile = {
        lines: [{ ...context.primaryProfile!.memline!, range: new RangeSelection({ name: 'bytes', unit: 'bytes' }).view({ start: 0, end: 200 }) }]
    };
    assert.deepEqual(resolveScopeViewport(null, { ...context, scopeLine: null, scopeProfile: otherProfile as typeof context.scopeProfile }), { start: 0, end: 200 });
});

test('scope override is inherited and explicit viewport wins without modifying the parent', () => {
    const scopeViewport = { start: 120, end: 150 };
    const explicit = { start: 130, end: 140 };
    const context = createContext();
    const nested = { ...context, scopeViewport };

    assert.equal(query('scopeViewport()')({}, nested), scopeViewport);
    assert.equal(resolveScopeViewport(explicit, nested), explicit);
    assert.deepEqual(query('scopeViewport()')({}, context), { start: 100, end: 200 });
    assert.deepEqual(resolveScopeViewport(null, { ...nested, scopeViewport: null }), { start: 100, end: 200 });
    assert.equal(resolveScopeViewport(null, {} as typeof context), null);
});

test('checks viewport values at runtime, including empty, malformed and non-finite ranges', () => {
    const context = createContext();
    const scopeViewport = { start: 125, end: 150 };
    const nested = { ...context, scopeViewport };
    for (const viewport of [{}, [], 'time', 1, true, { start: '1', end: 2 }, { start: 2, end: 1 }, { start: NaN, end: 2 }, { start: 0, end: Infinity }]) {
        assert.equal(resolveScopeViewport(viewport, nested), null);
        assert.deepEqual(resolveScopeViewport(null, { ...context, scopeViewport: viewport } as typeof context), { start: 100, end: 200 });
    }
    const empty = { start: 0, end: 0 };
    assert.equal(resolveScopeViewport(empty, context), empty);
    assert.equal(resolveScopeViewport(null, nested), scopeViewport);
    assert.equal(resolveScopeViewport(undefined, nested), scopeViewport);
});

test.each(['../pages/samples.js'])('keeps the existing local ruler and bins in one explicit context: %s', path => {
    let definition: { context: string };
    const register = (_: string, config: typeof definition) => {
        definition = config;
    };
    runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        discovery: { page: { define: register }, view: { define: register } },
        require: () => ({})
    });
    const range = new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: 60 }, 120);
    const parent = { scopeViewport: { start: 100, end: 200 }, scopeLine: { range } };
    const nested = query(definition!.context)({}, parent);

    assert.deepEqual(query('scopeViewport()')({}, nested), { start: 120, end: 180 });
    assert.equal(query('scopeViewport()')({}, parent), parent.scopeViewport);
});
