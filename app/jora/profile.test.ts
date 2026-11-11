import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, resolveScopeViewport } from './profile.js';
import { methods as viewportMethods } from './viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

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
        primaryProfile,
        primaryLineType: 'timeline',
        primaryBreakdownKind: null,
        scopeProfile: null,
        scopeLine: null,
        scopeBreakdown: null,
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
    const otherScope = {
        ...context,
        scopeLine: null,
        scopeProfile: otherProfile
    };
    assert.deepEqual(resolveScopeViewport(null, otherScope), { start: 0, end: 200 });
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
    const malformed = [
        {},
        [],
        'time',
        1,
        true,
        { start: '1', end: 2 },
        { start: 2, end: 1 },
        { start: NaN, end: 2 },
        { start: 0, end: Infinity }
    ];

    for (const viewport of malformed) {
        const inherited = { ...context, scopeViewport: viewport } as typeof context;

        assert.equal(resolveScopeViewport(viewport, nested), null);
        assert.deepEqual(resolveScopeViewport(null, inherited), { start: 100, end: 200 });
    }

    const empty = { start: 0, end: 0 };
    assert.equal(resolveScopeViewport(empty, context), empty);
    assert.equal(resolveScopeViewport(null, nested), scopeViewport);
    assert.equal(resolveScopeViewport(undefined, nested), scopeViewport);
});

test('the samples page keeps its local ruler and bins in one explicit context', async () => {
    let definition: { context: string };
    const register = (_: string, config: typeof definition) => {
        definition = config;
    };
    evaluateModule(new URL('../pages/samples.js', import.meta.url), {
        discovery: { page: { define: register }, view: { define: register } },
        require: () => ({})
    });
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const parent = { scopeViewport: { start: 100, end: 200 }, scopeLine: line };
    const nested = query(definition!.context)({}, parent);

    assert.deepEqual(query('scopeViewport()')({}, nested), { start: 120, end: 180 });
    assert.equal(query('scopeViewport()')({}, parent), parent.scopeViewport);
});

test.each([
    ['timeline', '2420275.formatValue()', '2420.3 ms'],
    ['timeline', '2420275.formatValue(33.6)', '2420.28 ms'],
    ['timeline', '2420275.formatValue(5000)', '2420.3 ms'],
    ['memline', '2420275.formatValue()', '2420.3Kb'],
    ['memline', '2420275.formatValue(33.6)', '2420.28Kb'],
    ['memline', '2420275.formatValue(5000)', '2420.3Kb']
] as const)('on a %s %s is %s', async (type, formatQuery, expected) => {
    const { line } = await createLineFixture({ type, values: new Uint32Array([500]) });

    assert.equal(query(formatQuery)(null, { scopeLine: line }), expected);
});

test.each([
    ['timeline', 3.36, { value: '0.336', unit: 'ms' }],
    ['timeline', undefined, { value: '0.3', unit: 'ms' }],
    ['memline', 3.36, { value: '0.336', unit: 'Kb' }],
    ['memline', undefined, { value: '0.3', unit: 'Kb' }]
] as const)('on a %s 336 with a resolution of %s is %o', async (type, resolution, expected) => {
    const { line } = await createLineFixture({ type, values: new Uint32Array([500]) });

    assert.deepEqual(line.valueWithUnit(336, resolution), expected);
});
