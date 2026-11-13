import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { createSessionFixture } from '../../test/fixtures/profile.js';
import { createRootScope, deriveScope, missingScopeElement, methods, type Scope } from './scope.js';
import { lineViewport, methods as viewportMethods } from './viewport.js';

// Names of the selected elements that aren't within their anchors
function inconsistentElements(scope: Scope) {
    const names: string[] = [];

    if (scope.process !== null && scope.process.session !== scope.session) {
        names.push('process');
    }

    if (scope.thread !== null && scope.thread.process !== scope.process) {
        names.push('thread');
    }

    if (scope.profile !== null && scope.profile.thread !== scope.thread) {
        names.push('profile');
    }

    if (scope.line !== null && scope.line.profile !== scope.profile) {
        names.push('line');
    }

    if (scope.breakdown !== null && scope.breakdown.line !== scope.line) {
        names.push('breakdown');
    }

    if (scope.scale !== null && scope.scale.profile !== scope.profile) {
        names.push('scale');
    }

    return names;
}

// Names of the selected elements
function selectedElements(scope: Scope) {
    const names = ['session', 'process', 'thread', 'profile', 'line', 'breakdown', 'scale'] as const;

    return names.filter(name => scope[name] !== null);
}

test('a profile selects its owners, the line and breakdown of the requested kinds, the line as the scale', async () => {
    const { session, renderer, main, first } = await createSessionFixture();
    const scope = createRootScope([session], first, 'memline', 'location');

    assert.deepEqual(inconsistentElements(scope), []);
    assert.equal(scope.session, session);
    assert.equal(scope.process, renderer);
    assert.equal(scope.thread, main);
    assert.equal(scope.line, first.memline);
    assert.equal(scope.breakdown!.kind, 'location');
    assert.equal(scope.scale, first.memline);
    assert.deepEqual(selectedElements(createRootScope([session], null, 'memline', 'location')), []);
});

test('a later element of the table decides the anchors, a given value outside them requests its kind', async () => {
    const { session, first, cpuOnly } = await createSessionFixture();
    const root = createRootScope([session], null, null, null);
    const breakdown = first.timeline!.breakdowns[1];
    const fromBreakdown = deriveScope(root, { profile: cpuOnly, breakdown });

    assert.deepEqual(inconsistentElements(fromBreakdown), []);
    assert.equal(fromBreakdown.profile, first);
    assert.equal(fromBreakdown.breakdown, breakdown);
    assert.deepEqual(fromBreakdown.requests, {
        line: 'timeline',
        breakdown: breakdown.kind,
        scale: null,
        viewport: null
    });

    // The scale selects the profile, the line of another profile is taken as a request of its type
    const fromScale = deriveScope(root, { line: first.timeline, scale: cpuOnly.timeline });

    assert.equal(fromScale.profile, cpuOnly);
    assert.equal(fromScale.line, cpuOnly.timeline);
    assert.equal(fromScale.scale, cpuOnly.timeline);
});

test('owners keep their values within their anchors, take a choice of the data or stay unselected', async () => {
    const { session, renderer, gpu, main, worker, first } = await createSessionFixture();
    const empty = createRootScope([session], null, 'memline', 'location');
    // A session has a default process, a process has no default thread
    const fromSession = deriveScope(empty, { session });

    assert.deepEqual(selectedElements(fromSession), ['session', 'process']);
    assert.equal(fromSession.process, renderer);

    const root = createRootScope([session], first, 'memline', 'location');

    assert.equal(deriveScope(root, { process: renderer }).profile, first);
    assert.equal(deriveScope(root, { thread: main }).breakdown, root.breakdown);
    assert.deepEqual(selectedElements(deriveScope(root, { thread: worker })), ['session', 'process', 'thread']);
    assert.deepEqual(selectedElements(deriveScope(root, { process: gpu })), ['session', 'process']);
    assert.deepEqual(selectedElements(deriveScope(root, { process: null })), ['session']);
    assert.deepEqual(inconsistentElements(deriveScope(root, { thread: worker })), []);
});

test('a line type and a breakdown kind select a line and a breakdown of them and are carried', async () => {
    const { session, first, cpuOnly } = await createSessionFixture();
    const root = createRootScope([session], cpuOnly, 'memline', 'location');

    // A profile without a memory line has no line and no scale selected, the requests are carried
    assert.deepEqual(selectedElements(root), ['session', 'process', 'thread', 'profile']);
    assert.equal(deriveScope(root, { profile: first }).line, first.memline);
    assert.equal(deriveScope(root, { profile: first }).breakdown!.kind, 'location');

    // A time line has no breakdown by location
    const timeline = deriveScope(deriveScope(root, { profile: first }), { line: 'timeline' });

    assert.equal(timeline.line, first.timeline);
    assert.equal(timeline.breakdown, null);
    assert.equal(deriveScope(timeline, { line: 'memline' }).breakdown!.kind, 'location');
    assert.equal(deriveScope(timeline, { line: null }).requests.line, null);
});

test('a scale of another kind places the line on the axis of another line and keeps its breakdown', async () => {
    const { session, first, cpuOnly } = await createSessionFixture();
    const root = createRootScope([session], first, 'memline', 'location');
    const onTime = deriveScope(root, { scale: 'time' });

    assert.equal(onTime.line, first.memline);
    assert.equal(onTime.breakdown, root.breakdown);
    assert.equal(onTime.scale, first.timeline);
    assert.equal(deriveScope(onTime, { line: 'timeline' }).scale, first.timeline);
    // A profile without a memory line has the requested scale, not the line
    assert.equal(deriveScope(onTime, { profile: cpuOnly }).scale, cpuOnly.timeline);
    assert.equal(deriveScope(onTime, { profile: cpuOnly }).line, null);

    // The line as the scale is the data's choice, not a request: the scale follows the line
    const timeline = deriveScope(root, { line: 'timeline' });

    assert.equal(timeline.scale, first.timeline);
    assert.equal(timeline.requests.scale, null);
    assert.equal(deriveScope(timeline, { line: 'memline' }).scale, first.memline);
});

test('a viewport is the scale viewport, a requested one is kept for scales sharing its coordinates', async () => {
    const { session, first, cpuOnly } = await createSessionFixture();
    const root = createRootScope([session], first, 'timeline', null);
    const viewport = root.viewport!;

    // The viewport of the scale is read on each access
    first.timeline!.viewport.selection.setRange(viewport.start + 1, viewport.start + 2);
    assert.deepEqual(root.viewport, { start: viewport.start + 1, end: viewport.start + 2 });

    const range = { start: 3, end: 4 };
    const requested = deriveScope(root, { viewport: range });

    assert.equal(requested.viewport, range);
    assert.equal(deriveScope(requested, { profile: cpuOnly }).viewport, range);
    // The memory line on the time scale keeps the range, the memory line on its own scale doesn't
    assert.equal(deriveScope(requested, { line: 'memline', scale: 'time' }).viewport, range);
    assert.deepEqual(deriveScope(requested, { line: 'memline' }).viewport, lineViewport(first.memline!));
    assert.deepEqual(deriveScope(requested, { viewport: null }).viewport, root.viewport);
    assert.deepEqual(deriveScope(requested, { viewport: { start: 2, end: 1 } }).viewport, root.viewport);
    assert.equal(deriveScope(requested, { profile: null }).viewport, null);
});

test('a missing element is the first unselected one of the required element and its anchors', async () => {
    const { session, renderer, gpu, main, worker, first, cpuOnly } = await createSessionFixture();
    const root = createRootScope([session], cpuOnly, 'memline', 'location');

    assert.equal(missingScopeElement(root, 'profile'), null);
    assert.equal(missingScopeElement(root, 'line')!.element, 'line');
    assert.deepEqual(missingScopeElement(root, 'line')!.choices, cpuOnly.lines);
    // A breakdown needs the line it's relative to chosen first
    assert.equal(missingScopeElement(root, 'breakdown')!.element, 'line');
    assert.equal(missingScopeElement(deriveScope(root, { profile: first }), 'breakdown'), null);
    // A scale is relative to the profile only
    assert.equal(missingScopeElement(deriveScope(root, { scale: 'time' }), 'scale'), null);

    const empty = createRootScope([session], null, null, null);

    assert.equal(missingScopeElement(empty, 'session')!.choices[0], session);
    assert.deepEqual(missingScopeElement(deriveScope(empty, { session }), 'thread')!.choices, [main, worker]);
    assert.equal(missingScopeElement(deriveScope(empty, { process: gpu }), 'thread')!.choices.length, 0);
    assert.equal(missingScopeElement(deriveScope(empty, { thread: worker }), 'profile')!.choices.length, 0);
    assert.equal(missingScopeElement(deriveScope(empty, { session }), 'process'), null);
    assert.equal(deriveScope(empty, { session }).process, renderer);
});

test('a view derives the scope of its content in a context query, the key takes the name of the method', async () => {
    const { session, main, first, cpuOnly } = await createSessionFixture();
    const query = jora.setup({
        methods: {
            ...methods,
            ...viewportMethods
        }
    });
    const context = {
        scope: createRootScope([session], first, 'timeline', null)
    };
    // A nested view derives from the scope of its context
    const profileContext = query('{ ...#, scope({ profile: $ }) }')(cpuOnly, context);
    const lineContext = query('{ ...#, scope({ line: "memline" }) }')(null, profileContext);

    assert.equal(profileContext.scope.line, cpuOnly.timeline);
    assert.equal(lineContext.scope.line, null);
    assert.equal(query('#.scope.thread')(null, lineContext), main);
    assert.equal(missingScopeElement(lineContext.scope, 'line')!.element, 'line');
    assert.equal(context.scope.line, first.timeline);
});
