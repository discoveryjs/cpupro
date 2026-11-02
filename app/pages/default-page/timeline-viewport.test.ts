import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../../jora/index.mjs';
import { chartUsedHeap } from './chart-used-heap.js';
import { userTimingsTimeline } from './user-timings-timeline.js';
import { createState, selectRange, rangeToSegments } from '../../views/ruler-range.js';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';
import { histCodes } from './hist-codes.js';
import { histHeapTotal } from './hist-heap-total.js';

const timeline = runInNewContext(readFileSync(new URL('../default.js', import.meta.url), 'utf8') + '\ncategoriesTimeline;', {
    require: () => ({ supportedFormats: [], sessionExpandState: () => ({}), chartUsedHeap, userTimingsTimeline }),
    discovery: {
        nav: { primary: { append() {} } },
        page: { define() {} },
        view: { getViewStackTrace: target => target?.views ?? null }
    }
});
const query = jora.setup({ methods: { ...methods, marker: () => ({ href: '#' }) } });

test('tooltip dispatch selects one section and uses its current local data and scope', () => {
    const renderDetails = timeline.content[0].details.content[1].content.at(-1);
    const calls = [];
    const renderer = { render: (...args) => calls.push(args) };
    const heap = {
        config: histHeapTotal,
        data: { revision: 1 },
        context: { scopeProfile: 'heap-profile', scopeLine: 'heap-line', scopeBreakdown: 'heap-breakdown' }
    };
    const codes = { config: histCodes, data: { revision: 2 }, context: { scopeLine: 'code-line' } };
    const target = { views: [heap, { config: {}, data: null, context: {} }] };
    const detail = { start: 20, end: 30 };
    const context = {
        detailTarget: target,
        detail,
        ruler: { selection: null },
        binStart: 2,
        binEnd: 3,
        scopeProfile: 'parent-profile',
        scopeLine: 'parent-line',
        scopeBreakdown: 'parent-breakdown'
    };

    renderDetails.call(renderer, null, {}, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], histHeapTotal.rulerDetails);
    assert.equal(calls[0][2], heap.data);
    assert.equal(calls[0][3].detail, detail);
    assert.equal(calls[0][3].scopeProfile, 'heap-profile');
    assert.equal(calls[0][3].scopeLine, 'heap-line');
    assert.equal(calls[0][3].scopeBreakdown, 'heap-breakdown');

    target.views = [heap, codes];
    renderDetails.call(renderer, null, {}, context);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], histCodes.rulerDetails);
    assert.equal(calls[1][2], codes.data);
    assert.equal(calls[1][3].scopeLine, 'code-line');

    codes.data = { revision: 3 };
    codes.context = { scopeLine: 'changed-breakdown' };
    renderDetails.call(renderer, null, {}, context);
    assert.equal(calls[2][2], codes.data);
    assert.equal(calls[2][3].scopeLine, 'changed-breakdown');

    target.views = [];
    renderDetails.call(renderer, null, {}, context);
    renderDetails.call(renderer, null, {}, { ...context, detailTarget: null });
    assert.equal(calls.length, 3);
});

test('mapping bins belong to expanded content rather than the parent panel query', async () => {
    const { profile } = await createProfileFixture();
    let mappings = 0;
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binLineToAxisLine(...args) {
                mappings += args[1] === null ? 1 : 0;
                return methods.binLineToAxisLine.apply(this, args);
            }
        }
    });
    const context = tracked(timeline.context)(profile, { primaryProfile: profile, primaryLineType: 'timeline' });
    const panel = tracked(timeline.data)(profile, context);

    assert.equal(mappings, 0);

    const mapping = timeline.content.find(view => view?.view === 'expand');
    const data = tracked(mapping.data)(panel, context);
    const rows = tracked(mapping.content.data)(data, context);

    assert.equal(mappings, profile.lines.length);
    assert.equal(rows.length, profile.lines.length);
});

test('sections own their queries without eager parent calls and retain source coverage', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const calls = [];
    const tracked = jora.setup({
        methods: {
            ...methods,
            marker: () => ({ href: '#' }),
            binHeapTotal(...args) {
                calls.push('heap');
                return methods.binHeapTotal.apply(this, args);
            },
            binScriptFunctionCodesTotal(...args) {
                calls.push('codes');
                return methods.binScriptFunctionCodesTotal.apply(this, args);
            }
        }
    });
    const callFrameCodes = { topTier: 'Sparkplug', callFrame: {} };
    Object.assign(profile, {
        codes: [
            { tm: 5, tier: 'Ignition', callFrameCodes },
            { tm: 25, tier: 'Sparkplug', callFrameCodes }
        ],
        codesByCallFrame: [callFrameCodes]
    });
    profile.heap = { available: 200, capacity: 100, events: [{ tm: 60, event: 'new', size: 10, address: '0x1' }] };
    const context = tracked(timeline.context)(profile, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    });
    const panel = tracked(timeline.data)(profile, context);

    assert.deepEqual(calls, []);

    const heap = tracked(histHeapTotal.data)(panel, context);

    assert.deepEqual(calls, ['heap']);

    const codes = tracked(histCodes.data)(panel, context);

    assert.deepEqual(calls, ['heap', 'codes']);
    assert.equal(codes.compilations.length, 2);
    assert.equal(codes.byTier.find(tier => tier.name === 'Sparkplug').maxTier, 1);
    assert.deepEqual(codes.extent, { start: 0, end: 40 });

    assert.equal(panel.line, profile.timeline);
    assert.deepEqual(heap.extent, { start: 0, end: 60 });
    assert.equal(heap.newTotal, 10);
    const heapRows = histHeapTotal.content.content[0].content;
    assert.ok(Array.isArray(heapRows));
    for (const row of heapRows) {
        const histogram = row.content.at(-1)!;
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(heap, context), heap.extent);
    }
});

test('passes code coverage explicitly to each histogram without a context override', () => {
    const extent = { start: 10, end: 90 };
    const data = { extent, byTier: [{ name: 'Ignition', bins: [0, 1, 0] }] };
    const codeRows = histCodes.content.content[0].content;
    assert.ok(Array.isArray(codeRows));
    const [codes, functions, tiers] = codeRows;
    for (const row of [codes, functions]) {
        const histogram = row.content!.at(-1)!;
        assert.ok(histogram.extent);
        assert.equal(query(histogram.extent.slice(1))(data), extent);
    }
    const rows = query(tiers.data!)(data);
    const histogram = tiers.item!.content.at(-1)!;
    assert.ok(histogram.extent);
    assert.equal(query(histogram.extent.slice(1))(rows[0]), extent);
    assert.equal(data.byTier[0].bins, rows[0].bins);
});

test.each([100, 1000])('shares the viewport bin grid with rendering, ruler and details for duration=%i', async duration => {
    const origin = 1000;
    const { profile, line } = await createLineFixture({ origin: origin + duration * 0.2, values: new Uint32Array([duration * 0.6]) });
    const other = await createLineFixture({ origin, values: new Uint32Array([duration]) });
    const context = query(timeline.context)({}, {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [other.profile, profile] }
    });
    const viewport = query('scopeViewport()')({}, context);
    assert.deepEqual(viewport, { start: origin, end: origin + duration });
    const ruler = timeline.content[0];
    assert.deepEqual(query(ruler.range.slice(1))({}, context), viewport);
    const binCount = query(ruler.segments.slice(1))({}, context);
    assert.equal(binCount, Math.min(500, duration));
    const range = query(ruler.rangeManager.slice(1))({ line }, context);
    assert.equal(range, line.range.selection);
    range.setRange(origin + duration * 0.1, origin + duration * 0.4);
    assert.deepEqual(range.ranges, [{ start: origin + duration * 0.1, end: origin + duration * 0.4 }]);
    assert.deepEqual(line.range.ranges, [{ start: -duration * 0.1, end: duration * 0.2 }]);
    const bins = new Uint32Array(binCount).fill(1, binCount * 0.2, binCount * 0.8);
    for (const [start, end, count, noCoverage] of [[0, 0.1, 0, true], [0.2, 0.5, binCount * 0.3, false], [0.9, 1, 0, true]]) {
        const state = createState(viewport, binCount);
        const selected = selectRange(state, start, end);
        const indices = rangeToSegments(selected, state.segments)!;
        const details = query(ruler.details.context)({}, {
            ...context, timeStart: selected.start - viewport.start, timeEnd: selected.end - viewport.start,
            segmentStart: indices.start, segmentEnd: indices.end - 1
        });
        assert.equal(details.binStart, indices.start);
        assert.equal(details.binEnd, indices.end);
        assert.equal(details.noCoverage, noCoverage);
        const countQuery = ruler.details.content[0].content[2].content.slice('text-numeric:'.length);
        assert.equal(query(countQuery)([{ binSamples: bins }], details), `Samples: ${count}`);
    }
});

test('profile time charts keep their viewport and selection owner when the primary line changes', async () => {
    const { profile, line: timeLine } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const { line: memline } = await createLineFixture({ type: 'memline', values: new Uint32Array([1000]) });
    assert.equal(memline.type, 'memline');
    profile.memline = memline;
    profile.lines.push(memline);
    memline.profile = profile;
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    memline.range.setRange(2, 5);
    const memorySelection = memline.range.selection.ranges;
    const charts = timeline.content.at(-1);
    assert.equal(charts.content[0], chartUsedHeap);
    assert.equal(charts.content[1], userTimingsTimeline);

    for (const selectedLine of [timeLine, memline]) {
        const parentContext = query(timeline.context)({}, {
            primaryProfile: profile, primaryLineType: selectedLine.type,
            scopeLine: selectedLine, scopeBreakdown: { line: selectedLine },
            data: { profiles: [other.profile, profile] }
        });
        const context = query(charts.context)({}, parentContext);
        assert.equal(context.scopeLine, timeLine);
        assert.equal(context.scopeBreakdown, null);
        assert.deepEqual(query('scopeViewport()')({}, context), { start: 100, end: 200 });
        assert.equal(parentContext.scopeLine, selectedLine);

        for (const chart of charts.content) {
            const data = query(chart.data)({}, context);
            if (chart === chartUsedHeap) {
                assert.deepEqual(data.extent, { start: 120, end: 180 });
                const view = chart.content.content[0].content[0];
                assert.equal(query(view.extent.slice(1))(data, context), data.extent);
                assert.equal(query(view.minX.slice(1))(data, context), 100);
                assert.equal(query(view.maxX.slice(1))(data, context), 200);
            } else {
                const view = chart.content.content[0].content[0];
                assert.equal(view.minX, undefined);
                assert.equal(view.maxX, undefined);
                assert.deepEqual(query('scopeViewport()')(data, context), { start: 100, end: 200 });
            }
        }

        query('scopeLine()')({}, context).range.selection.setRange(130, 140);
        assert.deepEqual(timeLine.range.ranges, [{ start: 10, end: 20 }]);
        assert.equal(memline.range.selection.ranges, memorySelection);
    }
});

test('a nested viewport reaches bins, ruler and time charts without being recomputed', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const other = await createLineFixture({ values: new Uint32Array([100]) });
    const scopeViewport = { start: 15, end: 25 };
    const parent = {
        primaryProfile: profile, primaryLineType: 'timeline',
        data: { profiles: [profile, other.profile] }
    };
    const context = query(timeline.context)(profile, { ...parent, scopeViewport });
    const panel = query(timeline.data)(profile, context);
    const ruler = timeline.content[0];
    const chartsContext = query(timeline.content.at(-1).context)(panel, context);

    assert.equal(query('scopeViewport()')(panel, context), scopeViewport);
    assert.equal(query(ruler.range.slice(1))(panel, context), scopeViewport);
    assert.equal(panel.samples[0].bins.length, 10);
    assert.equal(query('scopeViewport()')(panel, chartsContext), scopeViewport);
    assert.deepEqual(query('scopeViewport()')({}, parent), { start: 0, end: 100 });
});
