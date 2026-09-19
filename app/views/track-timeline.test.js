import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, test, vi } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { TrackTimeline as CanvasTrackTimeline } from './track-timeline/index.js';
import { layoutSpans } from './track-timeline/layout.js';
import { SpanIndex } from './track-timeline/span-index.js';
import { SpanLabels } from './track-timeline/labels.js';

test('label thresholds reuse full and first-grapheme widths without ellipsis-only output', () => {
    const labels = new SpanLabels();
    const ctx = { measureText: vi.fn(text => ({ width: text.length * 6 })) };

    assert.equal(labels.fit(ctx, 'WXYZ', 11), '');
    assert.equal(labels.fit(ctx, 'WXYZ', 12), 'W\u2026');
    assert.equal(labels.fit(ctx, 'WXYZ', 24), 'WXYZ');
    const calls = ctx.measureText.mock.calls.length;
    assert.equal(labels.fit(ctx, 'WXYZ', 11), '');
    assert.equal(labels.fit(ctx, 'WXYZ', 24), 'WXYZ');
    assert.equal(ctx.measureText.mock.calls.length, calls);
    assert.equal(labels.fit(ctx, 'W', 6), 'W');
    assert.equal(labels.fit(ctx, 'W', 5), '');
    labels.clear();
    labels.fit(ctx, 'WXYZ', 11);
    assert.ok(ctx.measureText.mock.calls.length > calls);
});

test('label truncation keeps graphemes intact and measures composed text', () => {
    const labels = new SpanLabels();
    const grapheme = 'e\u0301';
    const emoji = '\ud83d\udc69\u200d\ud83d\udcbb';
    const ctx = { measureText: vi.fn(text => ({ width: text === grapheme + '\u2026' || text === emoji + '\u2026' ? 9 : text.length * 10 })) };

    assert.equal(labels.fit(ctx, grapheme + 'abcd', 9), grapheme + '\u2026');
    assert.equal(labels.fit(ctx, emoji + 'abcd', 9), emoji + '\u2026');
    assert.equal(labels.fit(ctx, emoji + 'abcd', 8), '');
    assert.ok(ctx.measureText.mock.calls.every(([text]) => !text.startsWith('e\u2026')));
});

test('render index progressively reveals dense spans without changing their identity', () => {
    const spans = Array.from({ length: 64 }, (_, index) => Object.freeze({ start: index * 2, end: index * 2 + 1 }));
    const index = new SpanIndex(Object.freeze(spans));
    const counts = [];

    for (const minDuration of [256, 32, 8, 2, 0]) {
        const visible = [];
        index.forEachVisible(0, 128, minDuration, (span, start, end) => {
            visible.push(span);
            assert.equal(span.start, start);
            assert.ok(end >= span.end);
            assert.ok(end === span.end || end - start < minDuration);
        });
        counts.push(visible.length);
        if (minDuration === 0) {
            visible.forEach((span, position) => assert.equal(span, spans[position]));
        }
    }

    assert.deepEqual(counts, [1, 4, 16, 64, 64]);
});

test('render index preserves large spans, gaps, points and partially visible ranges', () => {
    const spans = [{ start: 0, end: 100 }, { start: 100, end: 100 },
        { start: 100, end: 99 }, { start: 200, end: 201 }];
    const index = new SpanIndex(spans);
    const visible = [];

    index.forEachVisible(99, 202, 10, (span, start, end) => visible.push([span, start, end]));
    assert.equal(visible[0][0], spans[0]);
    assert.equal(visible.at(-1)[0], spans[3]);
    assert.ok(visible.every(([, start, end]) => !(start < 200 && end > 100)));

    const point = [];
    index.forEachVisible(100, 101, 1, span => point.push(span));
    assert.ok(point.includes(spans[1]));
    new SpanIndex([]).forEachVisible(0, 1, 1, () => assert.fail('Empty track'));
});

test('render index skips offscreen history and collapsed descendants', () => {
    let reads = 0;
    const spans = Array.from({ length: 65536 }, (_, index) => ({
        get start() {
            reads++;
            return index * 2;
        },
        end: index * 2 + 1
    }));
    const index = new SpanIndex(spans);

    reads = 0;
    const visible = [];
    index.forEachVisible(120000, 120010, 0, span => visible.push(span));
    assert.equal(visible.length, 5);
    assert.ok(reads < 100);

    reads = 0;
    index.forEachVisible(0, 131072, 262144, span => assert.equal(span, spans[0]));
    assert.equal(reads, 1);
});

function referenceLayout(spans) {
    const tracks = [];

    for (const span of [...spans].sort((left, right) => (right.end - right.start) - (left.end - left.start))) {
        let track = tracks.find(candidate => !candidate.some(existing =>
            existing.start < Math.max(span.end, span.start + 0.001) &&
            span.start < Math.max(existing.end, existing.start + 0.001)
        ));

        if (!track) {
            tracks.push(track = []);
        }
        track.push(span);
    }

    return tracks.map(track => track.sort((left, right) => left.start - right.start));
}

function assertLayout(spans) {
    const original = spans.slice();
    const expected = referenceLayout(spans);
    const actual = [...layoutSpans(spans)].filter(track => track !== null);

    assert.deepEqual(actual, expected);
    for (let trackIndex = 0; trackIndex < actual.length; trackIndex++) {
        for (let index = 0; index < actual[trackIndex].length; index++) {
            assert.equal(actual[trackIndex][index], expected[trackIndex][index]);
        }
    }
    assert.deepEqual(spans, original);
}

test('layout preserves duration priority, stable ties, nesting and partial overlaps', () => {
    for (const coordinates of [
        [], [[0, 2], [1, 5], [4, 10]],
        [[0, 100], [0, 50], [50, 100], [10, 20], [10, 20], [60, 70]],
        [[0, 0], [0, 0.0005], [0.0005, 0.0005], [0.001, 0.002], [0, -1]],
        [[1e14, 1e14], [1e14, 1e14 + 1], [1e14 + 1, 1e14 + 1]],
        [[1e14, 1e14], [1e14, 1e14], [1e14, 1e14 - 1]]
    ]) {
        const spans = coordinates.map(([start, end]) => Object.freeze({ start, end }));
        assertLayout(Object.freeze(spans));
        assertLayout(Object.freeze(spans.slice().reverse()));
    }
});

test('layout matches first-fit on reproducible mixed intervals', () => {
    let seed = 61453;
    const random = limit => Math.floor(((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * limit);

    for (let trial = 0; trial < 1000; trial++) {
        const origin = [0, -100, 1e12, 1e14][trial % 4];
        const scale = trial % 3 === 0 ? 0.0001 : 1;
        const spans = Array.from({ length: random(60) }, () => {
            const start = origin + random(120) * scale;
            return { start, end: start + (random(45) - 5) * scale };
        });

        assertLayout(spans);
    }
});

test('nested layout keeps stable ties and falls back without publishing a partial result', () => {
    const spans = Array.from({ length: 2000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));

    assertLayout([...spans, { start: 4000, end: 4002 }, { start: 4001, end: 4005 }, { start: 4004, end: 4010 }]);
    assertLayout([
        { start: 0, end: 100 },
        { start: 10, end: 20 },
        { start: 10, end: 20 },
        { start: 10, end: 10.0005 },
        { start: 10, end: 10 },
        { start: 30, end: 30.0005 },
        { start: 30.0002, end: 30.0002 }
    ]);
});

test('deep nesting requires linear checkpoints after sorting', () => {
    const spans = Array.from({ length: 10000 }, (_, index) => ({ start: index, end: 20000 - index }));
    let checkpoints = 0;
    let trackIndex = 0;

    for (const track of layoutSpans(spans)) {
        if (track === null) {
            checkpoints++;
        } else {
            assert.equal(track.length, 1);
            assert.equal(track[0], spans[trackIndex++]);
        }
    }

    assert.equal(trackIndex, spans.length);
    assert.ok(checkpoints < 30);
});

test('mixed layout fixes crossing ancestors before placing nested descendants', () => {
    const spans = [
        { start: 0, end: 50 },
        { start: 40, end: 100 },
        { start: 10, end: 30 },
        { start: 15, end: 25 },
        { start: 60, end: 90 },
        { start: 65, end: 85 },
        { start: 65, end: 85 }
    ];

    assertLayout(spans);
    assertLayout(spans.slice().reverse());
});

test('crossing core includes containing ancestors and preserves original equal-duration priority', () => {
    for (const coordinates of [
        [[0, 120], [0, 100], [10, 50], [40, 80], [45, 46], [90, 95]],
        [[40, 90], [0, 50], [10, 15], [45, 46], [70, 80], [75, 76]],
        [[0, 10], [5, 20], [11, 12], [13, 15], [19, 25], [21, 22]],
        [[0, 0], [0.0001, 0.0003], [0.0002, 0.0002], [0.002, 0.004]],
        [[0, 2], [1, 5], [4, 10]]
    ]) {
        const spans = coordinates.map(([start, end]) => Object.freeze({ start, end }));

        assertLayout(Object.freeze(spans));
        assertLayout(Object.freeze(spans.slice().reverse()));
    }

    const repeated = Object.freeze({ start: 10, end: 30 });
    assertLayout([repeated, { start: 20, end: 50 }, repeated, { start: 22, end: 25 }]);
});

test('crossing core preserves layout beyond a machine-word number of tracks', () => {
    const spans = Array.from({ length: 40 }, (_, index) => ({ start: index, end: 100 + index }));

    assertLayout([...spans, { start: 50, end: 60 }, { start: 51, end: 59 }]);
});

test('crossing core reconstructs shuffled nested forests with sparse crossings', () => {
    let seed = 8128;
    const random = limit => Math.floor(((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * limit);

    for (let trial = 0; trial < 100; trial++) {
        const spans = [{ start: 0, end: 500 }, { start: 100, end: 600 }];

        for (let block = 0; block < 12; block++) {
            const start = block * 50;
            spans.push({ start, end: start + 40 });
            for (let depth = 0; depth < 6; depth++) {
                spans.push({ start: start + depth, end: start + 20 - depth });
            }
            if (random(4) === 0) {
                spans.push({ start: start + 10, end: start + 45 });
            }
        }

        for (let index = spans.length - 1; index > 0; index--) {
            const other = random(index + 1);
            [spans[index], spans[other]] = [spans[other], spans[index]];
        }

        assertLayout(spans);
    }
});

test('layout yields within a large track and leaves published tracks unchanged', () => {
    const spans = Array.from({ length: 10000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const layout = layoutSpans(spans);

    assert.equal(layout.next().value, null);
    const tracks = [];
    for (const track of layout) {
        if (track) {
            tracks.push(Object.freeze(track));
        }
    }
    assert.deepEqual(tracks, [spans]);
});

test.skipIf(!process.env.CPUPRO_TRACK_TIMELINE_FIXTURE)('layout matches the real trace fixture', { timeout: 60000 }, () => {
    const groups = JSON.parse(readFileSync(process.env.CPUPRO_TRACK_TIMELINE_FIXTURE, 'utf8'));
    const measurements = [];

    for (const { tid, events } of groups) {
        const referenceStart = performance.now();
        const expected = referenceLayout(events);
        const referenceMs = performance.now() - referenceStart;
        const layoutStart = performance.now();
        const actual = [];

        for (const track of layoutSpans(events)) {
            if (track) {
                actual.push(track);
            }
        }

        const layoutMs = performance.now() - layoutStart;
        assert.equal(actual.length, expected.length);
        for (let trackIndex = 0; trackIndex < actual.length; trackIndex++) {
            assert.equal(actual[trackIndex].length, expected[trackIndex].length);
            for (let index = 0; index < actual[trackIndex].length; index++) {
                assert.equal(actual[trackIndex][index], expected[trackIndex][index]);
            }
        }
        measurements.push({ tid, spans: events.length, tracks: actual.length, referenceMs, layoutMs });
    }

    console.table(measurements);
});

afterEach(() => vi.unstubAllGlobals());

async function renderTimeline(config = {}, scopeViewport) {
    const { line: scopeLine } = await createLineFixture({ origin: 125, values: new Uint32Array([50]), before: 5, after: 5 });
    const { selection } = scopeLine.range;
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const context = { scopeLine, scopeViewport, data: { profiles: [
        scopeLine.profile, other.profile
    ] } };
    let render;
    let timeline;
    let hover;
    let tooltipContext;
    const element = { classList: new Set(), append() {} };
    const destroyElement = {};

    runInNewContext(readFileSync(new URL('./track-timeline.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), {
        resolveScopeProfileLine, resolveScopeViewport,
        discovery: { view: { define: (_, callback) => render = callback } },
        utils: { createElement: name => name === 'destroy-track-timeline' ? destroyElement : element },
        HTMLElement: class {}, customElements: { define() {} },
        TrackTimeline: class {
            constructor(_, options) {
                timeline = {
                    options,
                    setSelection(selection) {
                        this.selection = selection;
                    },
                    destroy() {}
                };
                return timeline;
            }
        },
        Tooltip: class {
            constructor(_, callback) {
                this.el = element;
                hover = callback;
            }
            destroy() {}
        }
    });
    render.call({ render: (_, config, data, context) => tooltipContext = context }, element, config, null, context);
    destroyElement.onConnect();
    return { timeline, selection, destroyElement, hover: span => {
        hover(element, span);
        return tooltipContext;
    } };
}

test('uses the common viewport or its scoped and explicit overrides', async () => {
    for (const [config, scoped, expected] of [
        [{}, undefined, { start: 100, end: 200 }],
        [{}, { start: 130, end: 160 }, { start: 130, end: 160 }],
        [{ viewport: { start: 90, end: 210 } }, { start: 130, end: 160 }, { start: 90, end: 210 }],
        [{ minX: 10, maxX: 900 }, { start: 130, end: 160 }, { start: 10, end: 900 }]
    ]) {
        const { timeline, hover } = await renderTimeline(config, scoped);
        assert.equal(timeline.options.minX, expected.start);
        assert.equal(timeline.options.maxX, expected.end);
        const tooltipContext = hover({ start: 135, end: 145 });
        assert.equal(tooltipContext.spanStart, 135 - expected.start);
        assert.equal(tooltipContext.spanEnd, 145 - expected.start);
    }
});

test('preserves absolute selection on span clicks, external changes and reset', async () => {
    const { timeline, selection, destroyElement } = await renderTimeline();
    timeline.options.onClick({ start: 110, end: 140 });
    assert.deepEqual(selection.ranges, [{ start: 110, end: 140 }]);
    assert.equal(timeline.selection, selection.ranges);
    selection.setRanges([{ start: 105, end: 115 }, { start: 150, end: 160 }]);
    assert.equal(timeline.selection, selection.ranges);
    assert.equal(timeline.selection.length, 2);
    timeline.options.onClick(null);
    assert.equal(selection.ranges, null);
    assert.equal(timeline.selection, null);
    destroyElement.onDestroy();
    selection.setRange(120, 130);
    assert.equal(timeline.selection, null);
});

function createCanvasTimeline(options = {}, height = 100, dpr = 1) {
    let scheduled;
    let layoutScheduled;
    vi.stubGlobal('window', { devicePixelRatio: dpr });
    vi.stubGlobal('ResizeObserver', class {
        observe() {} disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', callback => {
        scheduled = callback;
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => scheduled = null);
    vi.stubGlobal('setTimeout', callback => {
        layoutScheduled = callback;
        return 1;
    });
    vi.stubGlobal('clearTimeout', () => layoutScheduled = null);
    const rect = { left: 0, top: 0, width: 1000, height };
    const createCanvas = () => {
        const context = {
            fillRect: vi.fn(), strokeRect: vi.fn(), clearRect: vi.fn(),
            drawImage: vi.fn(),
            scale() {}, save() {}, restore() {}, beginPath() {}, closePath() {},
            rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {},
            measureText: text => ({ width: text.length * 6 })
        };
        const listeners = new Map();
        return { context, listeners, style: {}, getContext: () => context,
            getBoundingClientRect: () => rect,
            addEventListener: (name, callback) => listeners.set(name, callback)
        };
    };
    const base = createCanvas();
    const overlay = createCanvas();
    const fonts = new EventTarget();
    vi.stubGlobal('document', { createElement: createCanvas, fonts });
    const timeline = new CanvasTrackTimeline({
        querySelector: selector => selector.endsWith('__canvas') ? base : overlay,
        getBoundingClientRect: () => rect
    }, { minX: 100, maxX: 200, spans: [{ start: 120, end: 180 }], ...options });
    const flush = () => {
        base.context.fillRect.mockClear();
        overlay.context.fillRect.mockClear();
        overlay.context.clearRect.mockClear();
        if (layoutScheduled) {
            const callback = layoutScheduled;
            layoutScheduled = null;
            callback();
        }
        if (scheduled) {
            const callback = scheduled;
            scheduled = null;
            callback();
        }
    };
    flush();
    return { timeline, base, overlay, fonts, flush, pending: () => Boolean(scheduled || layoutScheduled) };
}

test('publishes a stable prefix of complete groups without exposing partial tracks', () => {
    let clock = 0;
    vi.stubGlobal('performance', { now: () => clock += 4 });
    const spans = Array.from({ length: 6000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const { timeline, base, overlay, flush, pending } = createCanvasTimeline({ groups: true, spans: [
        { name: 'First', spans: [{ start: 120, end: 180 }] },
        { name: 'Large', spans },
        { name: 'Collapsed', collapsed: true, spans },
        { name: 'Empty', spans: [] },
        { name: 'Last', spans: [{ start: 130, end: 150 }] }
    ] });
    const firstGroup = timeline.groups[0];
    const geometry = [firstGroup.startY, firstGroup.endY];
    const firstTracks = timeline.tracks.slice();

    assert.deepEqual(timeline.visibleGroups.map(group => group.name), ['First']);
    assert.equal(firstTracks.length, 2);
    flush();
    assert.equal(base.context.fillRect.mock.calls.length, 0);
    assert.equal(overlay.context.clearRect.mock.calls.length, 0);

    let previousCount = timeline.visibleGroups.length;
    let batches = 0;
    while (pending() && batches++ < 100) {
        flush();
        assert.deepEqual([firstGroup.startY, firstGroup.endY], geometry);
        assert.equal(timeline.tracks[1], firstTracks[1]);
        assert.ok(timeline.visibleGroups.length >= previousCount);
        previousCount = timeline.visibleGroups.length;
        for (const group of timeline.visibleGroups) {
            assert.ok(group.complete || group.collapsed);
        }
    }

    assert.equal(pending(), false);
    assert.deepEqual(timeline.visibleGroups.map(group => group.name), ['First', 'Large', 'Collapsed', 'Empty', 'Last']);
    assert.deepEqual(timeline.groups[1].tracks[0].spans, spans);
    assert.equal(timeline.groups[2].layout, null);
    assert.equal(timeline.groups[2].complete, false);
    timeline.destroy();
});

test('lays out small groups in one batch and reuses their tracks after collapse', () => {
    const groups = [
        { name: 'First', spans: [{ start: 120, end: 180 }] },
        { name: 'Second', spans: [{ start: 130, end: 160 }] }
    ];
    const { timeline, overlay, flush, pending } = createCanvasTimeline({ spans: groups, groups: true });

    assert.equal(timeline.groups[0].complete, true);
    assert.equal(timeline.groups[1].complete, true);
    assert.equal(pending(), false);
    const tracks = timeline.groups.map(group => group.tracks[0]);
    const pointer = { button: 0, clientX: 20, clientY: 35, stopPropagation() {} };

    for (const collapsed of [true, false]) {
        overlay.listeners.get('pointerdown')(pointer);
        overlay.listeners.get('pointerup')(pointer);
        flush();
        assert.equal(timeline.groups[0].collapsed, collapsed);
        assert.equal(timeline.groups[0].tracks[0], tracks[0]);
        assert.equal(timeline.groups[1].tracks[0], tracks[1]);
    }
    timeline.destroy();
});

test('yields within a group and discards pending layout on replacement or destroy', () => {
    let clock = 0;
    vi.stubGlobal('performance', { now: () => clock++ });
    const spans = Array.from({ length: 10000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const { timeline, flush, pending } = createCanvasTimeline({ spans, minX: undefined, maxX: undefined });

    assert.equal(timeline.minX, 0);
    assert.equal(timeline.maxX, 19999);
    assert.equal(pending(), true);
    assert.equal(timeline.groups[0].complete, false);
    const oldLayout = timeline.groups[0].layout;
    const replacement = { start: 10, end: 20 };

    timeline.setSpans([replacement]);
    assert.equal(oldLayout.next().done, true);
    flush();
    assert.deepEqual(timeline.tracks.map(track => track.spans), [[replacement]]);
    assert.equal(pending(), false);

    timeline.setSpans(spans);
    flush();
    const pendingLayout = timeline.groups[0].layout;
    assert.equal(pending(), true);
    timeline.destroy();
    assert.equal(pendingLayout.next().done, true);
    assert.equal(pending(), false);
    timeline.setSelection(null);
    assert.equal(pending(), false);
});

test('pauses a collapsed group and resumes its existing iterator on expansion', () => {
    let clock = 0;
    vi.stubGlobal('performance', { now: () => clock += 4 });
    const spans = Array.from({ length: 10000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const { timeline, flush, pending } = createCanvasTimeline({ groups: true, spans: [
        { name: 'Large', collapsed: true, spans },
        { name: 'Small', spans: [{ start: 120, end: 180 }] }
    ] });
    timeline.handleGroupTitleClick(10, 35);
    flush();
    const layout = timeline.groups[0].layout;
    assert.ok(layout);
    const otherTrack = timeline.groups[1].tracks[0];
    const otherOffset = timeline.groups[1].startY;
    assert.equal(timeline.tracks.length, 3);

    timeline.handleGroupTitleClick(10, 35);
    flush();
    assert.equal(timeline.groups[0].layout, layout);
    assert.equal(timeline.groups[1].complete, true);
    assert.equal(pending(), false);

    timeline.handleGroupTitleClick(10, 35);
    flush();
    assert.equal(timeline.groups[0].layout, layout);
    let frames = 0;
    while (pending() && frames++ < 100) {
        if (!timeline.groups[0].complete) {
            assert.equal(timeline.groups[1].startY, otherOffset);
        }
        flush();
    }

    assert.equal(pending(), false);
    assert.equal(timeline.groups[0].complete, true);
    assert.deepEqual(timeline.groups[0].tracks[0].spans, spans);
    assert.equal(timeline.groups[1].tracks[0], otherTrack);
    assert.ok(timeline.groups[1].startY > otherOffset);
    timeline.destroy();
});

test('bounds include collapsed and pending groups and handle empty data', () => {
    const { timeline, flush } = createCanvasTimeline({ groups: true, minX: undefined, maxX: undefined, spans: [
        { name: 'Hidden', collapsed: true, spans: [{ start: -20, end: 300 }] },
        { name: 'Visible', spans: [{ start: 100, end: 200 }] }
    ] });

    assert.equal(timeline.minX, -20);
    assert.equal(timeline.maxX, 300);
    assert.equal(timeline.groups[0].layout, null);
    assert.equal(timeline.groups[0].tracks.length, 0);
    timeline.setSpans([]);
    flush();
    assert.ok(Number.isFinite(timeline.pxPerMs) && timeline.pxPerMs > 0);
    timeline.destroy();
});

test('renders only visible tracks and keeps group intervals when the title is offscreen', () => {
    const spans = Array.from({ length: 20 }, () => ({ start: 110, end: 190 }));
    const { timeline, base, flush } = createCanvasTimeline({ groups: true, spans: [{
        name: 'Group', spans, intervals: [{ start: 120, end: 140, color: '#123' }]
    }] });
    const renderTrack = vi.spyOn(timeline, 'renderTrack');

    timeline.handleVerticalScroll(105);
    flush();
    assert.deepEqual(timeline.getVisibleTrackRange(), { start: 6, end: 10 });
    assert.equal(renderTrack.mock.calls.length, 4);
    assert.ok(base.context.fillRect.mock.calls.some(([left, top, width, height]) =>
        left === 200 && top === -75 && width === 200 && height === 344
    ));
    assert.equal(timeline.hitTest(200, 35), spans[5]);
    assert.equal(timeline.hitTest(200, 45), null);
    timeline.destroy();
});

test('does not redraw completed tracks while the next layout chunk is unpublished', () => {
    let clock = 0;
    vi.stubGlobal('performance', { now: () => clock += 4 });
    const spans = Array.from({ length: 10000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const { timeline, base, overlay, flush, pending } = createCanvasTimeline({ spans });

    assert.equal(pending(), true);
    flush();
    assert.equal(base.context.fillRect.mock.calls.length, 0);
    assert.equal(overlay.context.fillRect.mock.calls.length, 0);
    timeline.destroy();
});

test('clamps vertical position when replacement spans use the same time bounds', () => {
    const { timeline, flush } = createCanvasTimeline({
        spans: Array.from({ length: 20 }, () => ({ start: 120, end: 180 }))
    });

    timeline.handleVerticalScroll(200);
    flush();
    assert.equal(timeline.scrollY, 200);
    timeline.setSpans([{ start: 120, end: 180 }]);
    flush();
    assert.equal(timeline.scrollY, 0);
    assert.deepEqual(timeline.getVisibleTrackRange(), { start: 0, end: 1 });
    timeline.destroy();
});

test('renders dense tracks at continuous detail and hit tests the displayed representatives', () => {
    const spans = Array.from({ length: 4096 }, (_, index) => ({ start: index * 0.01, end: index * 0.01 + 0.001 }));
    const { timeline, flush, pending } = createCanvasTimeline({ spans, minX: 0, maxX: 60000000 });
    while (pending()) {
        flush();
    }
    const track = timeline.tracks[0];
    const counts = [];

    for (const scale of [0.001, 1, 10, 1000]) {
        timeline.pxPerMs = scale;
        timeline.setSelection(null);
        flush();
        const image = timeline.trackImages.get(track);
        counts.push(image.spans.length);
        for (let index = 0; index < image.spans.length; index++) {
            const start = image.positions[index * 2];
            const end = image.positions[index * 2 + 1];
            assert.ok(end > start);
            assert.ok(index === 0 || start >= image.positions[index * 2 - 1]);
            assert.equal(timeline.hitTest((start + end) / 2, 35), image.spans[index]);
        }
    }

    assert.equal(counts[0], 1);
    assert.ok(counts[1] > counts[0] && counts[2] > counts[1]);
    assert.equal(counts[3], 100);
    assert.equal(track.spans.length, 4096);
    timeline.destroy();
});

test('wheel zoom can resolve microsecond spans in a minute-long profile', () => {
    const { timeline, flush } = createCanvasTimeline({ minX: 0, maxX: 60000000, unit: 'us', spans: [
        { start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }
    ] });
    const track = timeline.tracks[0];
    assert.equal(timeline.trackImages.get(track).spans.length, 1);

    timeline.handleZoom(-10000, 0);
    flush();
    assert.equal(timeline.trackImages.get(track).spans.length, 3);
    assert.ok(timeline.pxPerMs > 1);
    assert.ok(Number.isFinite(timeline.pxPerMs));
    timeline.destroy();
});

test('relative ruler visits only visible ticks at deep zoom far from the origin', () => {
    const { timeline, base } = createCanvasTimeline({ minX: 100, maxX: 60000100 });
    let labels = 0;
    base.context.fillText = () => {
        assert.ok(++labels < 20);
    };
    timeline.offsetMs = 50000000;
    timeline.pxPerMs = 10;
    timeline.renderRuler(base.context);
    assert.ok(labels > 0);
    timeline.destroy();
});

test('minimum markers align with device pixels and keep original click ranges', () => {
    const spans = [{ start: 0.26, end: 0.26 }, { start: 0.4, end: 0.41 }, { start: 4, end: 4 }];
    const onClick = vi.fn();
    const { timeline, overlay } = createCanvasTimeline({ spans, minX: 0, maxX: 2000, onClick }, 100, 2);
    const image = timeline.trackImages.get(timeline.tracks[0]);

    assert.equal(image.positions[0], 0);
    for (const position of image.positions) {
        assert.ok(Number.isInteger(position * 2));
    }
    const pointer = { button: 0, clientX: 0.5, clientY: 35, stopPropagation() {} };
    overlay.listeners.get('pointerdown')(pointer);
    overlay.listeners.get('pointerup')(pointer);
    assert.equal(onClick.mock.calls[0][0], spans[0]);
    timeline.destroy();
});

test('small complete labels render below 20px and font loading invalidates metrics', () => {
    const { timeline, base, fonts, flush, pending } = createCanvasTimeline({ spans: [
        { start: 120, end: 121.3, text: 'X' }
    ] });
    const ctx = base.context;
    ctx.fillText = vi.fn();
    ctx.measureText = vi.fn(text => ({ width: text.length * 6 }));
    const span = timeline.tracks[0].spans[0];

    timeline.renderSpan(ctx, span, 0, 0, 13);
    assert.equal(ctx.fillText.mock.calls[0][0], 'X');
    assert.equal(ctx.measureText.mock.calls.length, 0);
    timeline.renderSpan(ctx, span, 0, 0, 11);
    assert.equal(ctx.fillText.mock.calls.length, 1);

    fonts.dispatchEvent(new Event('loadingdone'));
    assert.equal(timeline.trackImages.size, 0);
    timeline.renderSpan(ctx, span, 0, 0, 13);
    assert.equal(ctx.measureText.mock.calls.length, 1);
    flush();
    timeline.destroy();
    fonts.dispatchEvent(new Event('loadingdone'));
    assert.equal(pending(), false);
});

test('repaints reusable track canvases and hit buffers when horizontal coordinates change', () => {
    const { timeline, base, flush } = createCanvasTimeline({ groups: true, spans: [
        { name: 'First', spans: [{ start: 120, end: 180 }] },
        { name: 'Second', spans: [{ start: 130, end: 160 }] }
    ] }, 150);
    const firstTrack = timeline.groups[0].tracks[0];
    const image = timeline.trackImages.get(firstTrack);
    const positions = image.positions;
    const previousPositions = positions.slice();
    const spans = image.spans;
    const createCanvas = vi.spyOn(globalThis.document, 'createElement');
    const renderTrack = vi.spyOn(timeline, 'renderTrack');

    flush();
    assert.equal(timeline.trackImages.get(firstTrack), image);
    assert.equal(renderTrack.mock.calls.length, 0);
    timeline.setSelection([{ start: 125, end: 135 }]);
    flush();
    assert.equal(renderTrack.mock.calls.length, 0);
    assert.ok(base.context.drawImage.mock.calls.length > 0);

    timeline.handleZoom(-100, 500);
    flush();
    assert.equal(timeline.trackImages.get(firstTrack), image);
    assert.equal(image.positions, positions);
    assert.equal(image.spans, spans);
    assert.notDeepEqual(positions, previousPositions);
    assert.equal(createCanvas.mock.calls.length, 0);
    assert.equal(image.context.clearRect.mock.calls.length, 1);
    assert.equal(renderTrack.mock.calls.length, 2);

    timeline.offsetMs = 195;
    timeline.setSelection(null);
    flush();
    assert.equal(image.spans.length, 0);
    assert.equal(image.positions.length, 0);
    assert.equal(timeline.hitTest(300, 60), null);

    timeline.width = 800;
    timeline.dpr = 2;
    timeline.setSelection(null);
    flush();
    assert.equal(image.canvas.width, 1600);
    assert.equal(image.canvas.height, 30);
    assert.equal(createCanvas.mock.calls.length, 0);
    timeline.setSpans([]);
    assert.equal(timeline.trackImages.size, 0);
    timeline.destroy();
});

test('renders external multi-range selection on the overlay and minimap without a stale clicked span', () => {
    const { timeline, base, overlay, flush } = createCanvasTimeline();
    timeline.setSelection([{ start: 110, end: 130 }, { start: 160, end: 190 }]);
    flush();
    assert.deepEqual(overlay.context.fillRect.mock.calls, [[100, 0, 200, 90], [600, 0, 300, 90]]);
    assert.deepEqual(base.context.fillRect.mock.calls.slice(-2), [[100, 90, 200, 10], [600, 90, 300, 10]]);

    const pointer = { button: 0, clientX: 300, clientY: 35, stopPropagation() {} };
    overlay.listeners.get('pointerdown')(pointer);
    overlay.listeners.get('pointerup')(pointer);
    for (const selection of [[{ start: 140, end: 150 }], null, []]) {
        timeline.setSelection(selection);
        flush();
        assert.deepEqual(overlay.context.fillRect.mock.calls, selection?.length ? [[400, 0, 100, 90]] : []);
    }
    timeline.destroy();
});

test('renders the same absolute selection after local zoom and pan', () => {
    const { timeline, base, overlay, flush } = createCanvasTimeline();
    const selection = [{ start: 120, end: 180 }];
    overlay.listeners.get('wheel')({
        clientX: 500, deltaX: 0, deltaY: -300, shiftKey: false, preventDefault() {}
    });
    timeline.setSelection(selection);
    flush();
    const [[start, , width]] = overlay.context.fillRect.mock.calls;
    assert.ok(start < 200);
    assert.ok(width > 600);
    assert.deepEqual(base.context.fillRect.mock.calls.at(-1), [200, 90, 600, 10]);

    const pointer = { button: 0, clientX: 500, clientY: 20, stopPropagation() {} };
    overlay.listeners.get('pointermove')(pointer);
    overlay.listeners.get('pointerdown')(pointer);
    overlay.listeners.get('pointermove')({ ...pointer, clientX: 600 });
    overlay.listeners.get('pointerup')({ ...pointer, clientX: 600 });
    flush();
    assert.ok(overlay.context.fillRect.mock.calls[0][0] > start);
    assert.deepEqual(base.context.fillRect.mock.calls.at(-1), [200, 90, 600, 10]);
    assert.deepEqual(selection, [{ start: 120, end: 180 }]);
    timeline.destroy();
});
