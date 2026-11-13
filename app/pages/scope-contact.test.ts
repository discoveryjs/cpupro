// Transitional contact of the scope: contexts of a few views derive a scope next to the flat fields, the readers
// still use the flat fields, and the tests compare both at those views. It is deleted with the step that moves
// the readers to `#.scope` and retires the flat fields, which ends the migration adapter of the scope view
import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import type { Profile } from '../prepare/profile.mjs';
import type { ProfileLine } from '../prepare/lines/types.js';
import type { CpuProSession } from '../prepare/types.js';
import { methods } from '../jora/index.mjs';
import { createRootScope, missingScopeElement, type Scope } from '../jora/scope.js';
import { createSessionFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { findView } from '../../test/helpers/view-config.js';
import { samplePopulation } from './signals-page/populations.js';
import { correlations } from './signals-page/correlations.js';
import * as lineWindow from '../views/misc/line-window.js';
import * as signals from '../signals.js';

const query = jora.setup({ methods });

const categoriesTimeline = evaluateModule(new URL('./default.js', import.meta.url), {
    require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), ...lineWindow }),
    discovery: { nav: { primary: { append() {} } }, page: { define() {} }, view: {} }
}, 'categoriesTimeline');
const timeCharts = findView(categoriesTimeline, { view: 'context', when: 'scopeProfile().timeline' });

const signalDetails = evaluateModule(new URL('./signals.js', import.meta.url), {
    allPageHeader: () => [],
    ...signals,
    samplePopulation,
    correlations,
    discovery: { page: { define() {} } }
}, 'signalDetails');

function rootContext(
    session: CpuProSession,
    profile: Profile,
    lineType: 'timeline' | 'memline',
    breakdownKind: string | null
) {
    return {
        primaryProfile: profile,
        primaryLineType: lineType,
        primaryBreakdownKind: breakdownKind,
        scopeProfile: null,
        scopeLine: null,
        scopeBreakdown: null,
        scope: createRootScope([session], profile, lineType, breakdownKind),
        data: { profiles: session.profiles }
    };
}

type ScopeLevels = {
    profile: Profile | null;
    line: ProfileLine | null;
    breakdown: { kind: string; line: ProfileLine } | null;
    viewport: { start: number; end: number } | null;
};

// Elements as primitives: the index of the profile, the type of the line, the kind of the breakdown and whether it's
// of the line, the viewport, and the type of the line placing the data
function elementDescriptor(profiles: readonly Profile[], elements: ScopeLevels, scale: ProfileLine | null) {
    const { viewport } = elements;

    return {
        profile: profiles.indexOf(elements.profile as Profile),
        line: elements.line?.type ?? null,
        breakdown: elements.breakdown?.kind ?? null,
        breakdownOfLine: elements.breakdown !== null
            ? elements.breakdown.line === elements.line
            : null,
        viewport: viewport !== null
            ? [viewport.start, viewport.end]
            : null,
        scale: scale?.type ?? null
    };
}

// What the flat fields resolve to and what the scope is; the flat fields place data on the scope line
function scopeDescriptors(profiles: readonly Profile[], context: { scope: Scope }) {
    const flat: ScopeLevels = query(`{
        profile: scopeProfile(),
        line: scopeLine(),
        breakdown: scopeBreakdown(),
        viewport: scopeViewport()
    }`)(null, context);

    return {
        flat: elementDescriptor(profiles, flat, flat.line),
        scope: elementDescriptor(profiles, context.scope, context.scope.scale)
    };
}

// The time charts place data on the time line: the flat fields replace the line of the scope with it, so the
// breakdown falls back to one of the primary kind on the time line; the scope keeps the line and its breakdown
// and takes the time line as the scale
test.each([
    {
        title: 'the timeline',
        lineType: 'timeline' as const,
        breakdownKind: 'call-stack',
        expected: { profile: 0, line: 'timeline', breakdown: 'call-stack', breakdownOfLine: true },
        expectedFlat: { profile: 0, line: 'timeline', breakdown: 'call-stack', breakdownOfLine: true }
    },
    {
        title: 'the memline',
        lineType: 'memline' as const,
        breakdownKind: 'location',
        expected: { profile: 0, line: 'memline', breakdown: 'location', breakdownOfLine: true },
        expectedFlat: { profile: 0, line: 'timeline', breakdown: null, breakdownOfLine: null }
    }
])('default page time charts under $title', async ({ lineType, breakdownKind, expected, expectedFlat }) => {
    const { session, first } = await createSessionFixture();
    const context = query(timeCharts.context)(null, rootContext(session, first, lineType, breakdownKind));
    const { flat, scope } = scopeDescriptors(session.profiles, context);

    assert.deepEqual(scope, { ...expected, viewport: [0, 40], scale: 'timeline' });
    assert.deepEqual(flat, { ...expectedFlat, viewport: [0, 40], scale: 'timeline' });
    assert.equal(context.scope.thread, first.thread);
});

// Where the flat fields resolve an element to null, the scope has the element unselected too: the difference is
// in the owners, which the scope selects within each other, and in what a view requiring an element is told
test.each([
    {
        title: 'a profile with the primary line',
        index: 0,
        expected: {
            profile: 0,
            line: 'memline',
            breakdown: 'location',
            breakdownOfLine: true,
            viewport: [0, 160],
            scale: 'memline'
        },
        missing: null
    },
    {
        title: 'a profile without the primary line',
        index: 1,
        expected: {
            profile: 1,
            line: null,
            breakdown: null,
            breakdownOfLine: null,
            viewport: null,
            scale: null
        },
        missing: 'line'
    }
])('signals page details of $title', async ({ index, expected, missing }) => {
    const { session, first } = await createSessionFixture();
    const profile = session.profiles[index];
    const context = query(signalDetails.context)(profile, rootContext(session, first, 'memline', 'location'));
    const { flat, scope } = scopeDescriptors(session.profiles, context);

    assert.deepEqual(scope, expected);
    assert.deepEqual(flat, expected);
    assert.equal(missingScopeElement(context.scope, 'breakdown')?.element ?? null, missing);
});

test.each([
    ['populations', samplePopulation],
    ['correlations', correlations]
])('signals page %s of a line of the profile', async (_, section) => {
    const { session, first } = await createSessionFixture();
    const details = query(signalDetails.context)(first, rootContext(session, first, 'memline', 'location'));
    const lineView = findView(section('timeline'), { view: 'context' });
    const lineContext = query(lineView.context)(first, details);
    const { flat, scope } = scopeDescriptors(session.profiles, lineContext);
    const expected = {
        profile: 0,
        line: 'timeline',
        breakdown: null,
        breakdownOfLine: null,
        viewport: [0, 40],
        scale: 'timeline'
    };

    assert.deepEqual(scope, expected);
    assert.deepEqual(flat, expected);
    assert.equal(missingScopeElement(lineContext.scope, 'breakdown')!.element, 'breakdown');
});
