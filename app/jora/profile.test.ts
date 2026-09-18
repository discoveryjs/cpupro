import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, resolveScopeViewport } from './profile.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { methods as viewportMethods } from './viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';

const query = jora.setup({ methods: { ...methods, ...viewportMethods } });

async function createContext(): Promise<Parameters<typeof resolveScopeViewport>[1]> {
    const { profile: primaryProfile } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const { line: memline } = await createLineFixture({ type: 'memline', values: new Uint32Array([500]) });
    assert.equal(memline.type, 'memline');
    primaryProfile.memline = memline;
    primaryProfile.lines.push(memline);
    memline.profile = primaryProfile;
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    return {
        primaryProfile, primaryLineType: 'timeline', primaryBreakdownKind: null,
        scopeProfile: null, scopeLine: null, scopeBreakdown: null,
        data: { profiles: [primaryProfile, other.profile] }
    };
}

test('derives the default viewport from the resolved line, not the query data', async () => {
    const context = await createContext();
    for (const data of [{}, { viewport: { start: 0, end: 10 } }, { line: {} }]) {
        assert.deepEqual(query('scopeViewport()')(data, context), { start: 100, end: 200 });
    }
    context.primaryLineType = 'memline';
    assert.deepEqual(resolveScopeViewport(null, context), { start: 0, end: 500 });
    context.scopeLine = context.primaryProfile!.timeline;
    assert.deepEqual(resolveScopeViewport(null, context), { start: 100, end: 200 });
    const { profile: otherProfile } = await createLineFixture({ type: 'memline', values: new Uint32Array([200]) });
    assert.deepEqual(resolveScopeViewport(null, { ...context, scopeLine: null, scopeProfile: otherProfile }), { start: 0, end: 200 });
});

test('scope override is inherited and explicit viewport wins without modifying the parent', async () => {
    const scopeViewport = { start: 120, end: 150 };
    const explicit = { start: 130, end: 140 };
    const context = await createContext();
    const nested = { ...context, scopeViewport };

    assert.equal(query('scopeViewport()')({}, nested), scopeViewport);
    assert.equal(resolveScopeViewport(explicit, nested), explicit);
    assert.deepEqual(query('scopeViewport()')({}, context), { start: 100, end: 200 });
    assert.deepEqual(resolveScopeViewport(null, { ...nested, scopeViewport: null }), { start: 100, end: 200 });
    assert.equal(resolveScopeViewport(null, {} as typeof context), null);
});

test('checks viewport values at runtime, including empty, malformed and non-finite ranges', async () => {
    const context = await createContext();
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

test.each(['../pages/samples.js'])('keeps the existing local ruler and bins in one explicit context: %s', async path => {
    let definition: { context: string };
    const register = (_: string, config: typeof definition) => {
        definition = config;
    };
    runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        discovery: { page: { define: register }, view: { define: register } },
        require: () => ({})
    });
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const parent = { scopeViewport: { start: 100, end: 200 }, scopeLine: line };
    const nested = query(definition!.context)({}, parent);

    assert.deepEqual(query('scopeViewport()')({}, nested), { start: 120, end: 180 });
    assert.equal(query('scopeViewport()')({}, parent), parent.scopeViewport);
});
