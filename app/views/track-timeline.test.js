import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineViewportBounds, lineZoom, setLineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture, denseValues } from '../../test/fixtures/profile.js';
import { TrackTimeline as CanvasTrackTimeline } from './track-timeline/index.js';
import { layoutSpans } from './track-timeline/layout.js';
import { SpanIndex } from './track-timeline/span-index.js';
import { SpanLabels } from './track-timeline/labels.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

test('label thresholds reuse full and first-grapheme widths without ellipsis-only output', () => {
    const labels = new SpanLabels();
    const ctx = { measureText: vi.fn(text => ({ width: text.length * 6 })) };

    assert.equal(labels.fit(ctx, 'WXYZ', 11), '');
    assert.equal(labels.fit(ctx, 'WXYZ', 12), 'W\u2026');
    assert.equal(labels.fit(ctx, 'WXYZ', 18), 'WX\u2026');
    assert.equal(labels.fit(ctx, 'WXYZ', 23), 'WX\u2026');
    assert.equal(labels.fit(ctx, 'WXYZ', 24), 'WXYZ');
    const calls = ctx.measureText.mock.calls.length;
    assert.equal(labels.fit(ctx, 'WXYZ', 11), '');
    assert.equal(labels.fit(ctx, 'WXYZ', 24), 'WXYZ');
    assert.equal(ctx.measureText.mock.calls.length, calls);
    assert.equal(labels.fit(ctx, 'W', 6), 'W');
    assert.equal(labels.fit(ctx, 'W', 5), '');
    assert.equal(labels.fit(ctx, '', 24), '');
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

    // The view ends exactly at the last span: nodes reaching it are still fully visible
    for (const minDuration of [256, 32, 31, 8, 2, 0]) {
        const visible = [];
        index.forEachVisible(0, 127, minDuration, (span, start, end) => {
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

    // A 16-span node extends exactly 31: collapsing requires a strictly shorter extent
    assert.deepEqual(counts, [1, 4, 8, 16, 64, 64]);
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
    index.forEachVisible(50, 50, 1, () => assert.fail('Empty view'));
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

function assertTracks(actual, expected) {
    assert.deepEqual(actual, expected);
    for (let trackIndex = 0; trackIndex < actual.length; trackIndex++) {
        for (let index = 0; index < actual[trackIndex].length; index++) {
            assert.equal(actual[trackIndex][index], expected[trackIndex][index]);
        }
    }
}

function assertLayout(spans) {
    const original = spans.slice();

    assertTracks([...layoutSpans(spans)].filter(track => track !== null), referenceLayout(spans));
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

test('deep nesting requires linear checkpoints after sorting, also below sparse crossings', () => {
    const nest = (start, depth) => Array.from({ length: depth }, (_, index) => ({ start: start + index, end: start + 2 * depth - index }));
    const nested = nest(0, 10000);
    const roots = [{ start: 0, end: 100 }, { start: 50, end: 150 }];
    const sparse = nest(200, 3000);
    const sharedEnd = Array.from({ length: 3000 }, (_, index) => ({ start: 200 + index, end: 6200 }));
    const buried = [{ start: 0, end: 10 }, { start: 5, end: 100000 }];
    const underBuried = nest(20, 3000);

    for (const [spans, expected] of [
        [nested, nested.map(span => [span])],
        // Only the crossing roots form the core; the nest is placed chronologically from its parent's track
        [[...roots, ...sparse], [[roots[0], sparse[0]], [roots[1], sparse[1]], ...sparse.slice(2).map(span => [span])]],
        // Equal ends are containment, not crossings
        [[...roots, ...sharedEnd], [[roots[0], sharedEnd[0]], [roots[1], sharedEnd[1]], ...sharedEnd.slice(2).map(span => [span])]],
        // The first root expires inside the active stack before the nest starts under the second one
        [[...buried, ...underBuried], [[buried[1]], [buried[0], underBuried[0]], ...underBuried.slice(1).map(span => [span])]]
    ]) {
        const tracks = [];
        let checkpoints = 0;

        for (const track of layoutSpans(spans)) {
            if (track === null) {
                checkpoints++;
            } else {
                tracks.push(track);
            }
        }

        assertTracks(tracks, expected);
        assert.ok(checkpoints < 30);
    }
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
        // Corrected ends of all three round to 8.0005: the last start is nested only numerically,
        // yet outranks the lowest-priority ancestor at the bottom of the stack
        [[7.999500000000001, 8.0005], [7.999500000000001, 8.001500000000002], [7.9995, 8]],
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

// Events at 125–175 with 5 units without samples on each side, and another profile over 100–200
async function renderTimeline(config = {}, scopeViewport, initialSelection) {
    const { line: scopeLine } = await createLineFixture({ origin: 125, values: denseValues(50), before: 5, after: 5 });
    const { selection } = scopeLine.range;
    const other = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const context = { scopeLine, scopeViewport, data: { profiles: [
        scopeLine.profile, other.profile
    ] } };
    const calls = [];
    let render;
    let timeline;
    let hover;
    let tooltipContext;
    let LifecycleElement;
    const element = {
        classList: new Set(),
        children: [],
        append(...children) {
            element.children.push(...children);
        }
    };
    const destroyElement = { name: 'destroy-track-timeline' };
    const createElement = (name, className) => name === 'destroy-track-timeline'
        ? destroyElement
        : { name, className };

    selection.setRanges(initialSelection ?? null);
    evaluateModule(new URL('./track-timeline.js', import.meta.url), {
        resolveScopeProfileLine, resolveScopeViewport, lineZoom, setLineZoom, subscribeLineZoom, lineViewportBounds,
        discovery: { view: { define: (_, callback) => render = callback } },
        utils: { createElement },
        HTMLElement: class {},
        customElements: { define: (_, Element) => LifecycleElement = Element },
        TrackTimeline: class {
            constructor(_, options) {
                timeline = {
                    options,
                    setSelection(selection) {
                        this.selection = selection;
                    },
                    views: [],
                    setView(start, end) {
                        this.views.push({ start, end });
                    },
                    destroy: () => calls.push('timeline.destroy')
                };
                return timeline;
            }
        },
        Tooltip: class {
            constructor(_, callback) {
                this.el = { classList: new Set() };
                hover = callback;
                calls.push(['tooltip', this.el]);
            }
            show(span) {
                calls.push(['tooltip.show', span]);
            }
            hide() {
                calls.push('tooltip.hide');
            }
            destroy() {
                calls.push('tooltip.destroy');
            }
        }
    });
    render.call({ render: (_, config, data, context) => tooltipContext = context }, element, config, null, context);
    destroyElement.onConnect();
    const hoverSpan = span => {
        hover(element, span);
        return tooltipContext;
    };

    return {
        timeline,
        scopeLine,
        selection,
        element,
        destroyElement,
        calls,
        LifecycleElement,
        hover: hoverSpan
    };
}

test.each([
    {
        name: 'the common viewport',
        config: {},
        scoped: undefined,
        bounds: { start: 100, end: 200 }
    },
    {
        name: 'the scoped viewport',
        config: {},
        scoped: { start: 130, end: 160 },
        bounds: { start: 130, end: 160 }
    },
    {
        name: 'an explicit viewport',
        config: { viewport: { start: 90, end: 210 } },
        scoped: { start: 130, end: 160 },
        bounds: { start: 90, end: 210 }
    },
    {
        name: 'explicit bounds',
        config: { minX: 10, maxX: 900 },
        scoped: { start: 130, end: 160 },
        bounds: { start: 10, end: 900 }
    },
    {
        name: 'the viewport bounds with zoom',
        config: { zoom: true },
        scoped: { start: 130, end: 160 },
        bounds: { start: 100, end: 200 }
    }
])('the timeline takes $name and places tooltip spans from its start', async row => {
    const { bounds } = row;
    const { timeline, hover } = await renderTimeline(row.config, row.scoped);
    const { spanStart, spanEnd } = hover({ start: 135, end: 145 });

    assert.deepEqual([timeline.options.minX, timeline.options.maxX], [bounds.start, bounds.end]);
    assert.deepEqual([spanStart, spanEnd], [135 - bounds.start, 145 - bounds.start]);
});

test('the timeline element holds its canvases, timeline options default and the tooltip takes its class', async () => {
    const { element, timeline, calls } = await renderTimeline({ tooltipClassName: 'custom' });
    const defaults = [
        timeline.options.groups,
        timeline.options.ruler,
        timeline.options.unit,
        [...timeline.options.spans],
        [...timeline.options.intervals]
    ];

    assert.deepEqual([...element.classList], ['no-view-ruler-tooltip']);
    assert.deepEqual(element.children.map(child => child.className ?? child.name), [
        'view-track-timeline__canvas', 'view-track-timeline__overlay', 'destroy-track-timeline'
    ]);
    assert.deepEqual(defaults, [false, 'relative', 'us', [], []]);
    assert.deepEqual([...calls[0][1].classList], ['custom']);
});

test('hovering a span shows the tooltip, leaving it hides; destroying releases the timeline and the tooltip', async () => {
    const { timeline, destroyElement, calls } = await renderTimeline();
    const span = { start: 135, end: 145 };

    calls.length = 0;
    timeline.options.onHover(span);
    timeline.options.onHover(null);
    destroyElement.onDestroy();

    assert.deepEqual(calls, [['tooltip.show', span], 'tooltip.hide', 'timeline.destroy', 'tooltip.destroy']);
});

test('the destroy element calls its connect and destroy hooks once', async () => {
    const { LifecycleElement } = await renderTimeline();
    const element = new LifecycleElement();
    const hooks = [];

    element.onConnect = () => hooks.push('connect');
    element.onDestroy = () => hooks.push('destroy');
    element.connectedCallback();
    element.disconnectedCallback();

    assert.deepEqual(hooks, ['connect', 'destroy']);
    assert.deepEqual([element.onConnect, element.onDestroy], [null, null]);
});

test('a selection made before connecting is shown', async () => {
    const { timeline, selection } = await renderTimeline({}, undefined, [{ start: 130, end: 140 }]);

    assert.equal(timeline.selection, selection.ranges);
    assert.deepEqual(timeline.selection, [{ start: 130, end: 140 }]);
});

test('with zoom the view follows the displayed range of the line until destroyed, without zoom there is no view', async () => {
    const { timeline, scopeLine, destroyElement } = await renderTimeline({ zoom: true });

    scopeLine.zoom.selection.setRange(140, 150);
    scopeLine.zoom.resetRange();
    // Without a zoom request the viewport is displayed
    scopeLine.viewport.selection.setRange(120, 160);
    scopeLine.viewport.resetRange();
    assert.deepEqual(timeline.views, [
        { start: 100, end: 200 },
        { start: 140, end: 150 },
        { start: 100, end: 200 },
        { start: 120, end: 160 },
        { start: 100, end: 200 }
    ]);

    destroyElement.onDestroy();
    scopeLine.zoom.selection.setRange(140, 150);
    assert.equal(timeline.views.length, 5);
    scopeLine.zoom.resetRange();

    const { timeline: unzoomed, scopeLine: line } = await renderTimeline();

    line.viewport.selection.setRange(140, 150);
    assert.deepEqual(unzoomed.views, []);
    assert.equal(unzoomed.options.onViewChange, null);
    line.viewport.resetRange();
});

test.each([
    {
        name: 'within the bounds',
        viewport: null,
        request: [120, 150],
        zoom: [{ start: 120, end: 150 }],
        view: { start: 120, end: 150 }
    },
    {
        name: 'of the bounds',
        viewport: null,
        request: [100, 200],
        zoom: null,
        view: { start: 100, end: 200 }
    },
    {
        name: 'over the bounds',
        viewport: null,
        request: [99.9, 200.1],
        zoom: null,
        view: { start: 100, end: 200 }
    },
    {
        name: 'shorter than the bounds',
        viewport: null,
        request: [100, 199],
        zoom: [{ start: 100, end: 199 }],
        view: { start: 100, end: 199 }
    },
    // Within a viewport the view is kept inside it
    {
        name: 'before the viewport',
        viewport: { start: 120, end: 160 },
        request: [110, 130],
        zoom: [{ start: 120, end: 140 }],
        view: { start: 120, end: 140 }
    },
    {
        name: 'after the viewport',
        viewport: { start: 120, end: 160 },
        request: [150, 170],
        zoom: [{ start: 140, end: 160 }],
        view: { start: 140, end: 160 }
    },
    {
        name: 'over the viewport',
        viewport: { start: 120, end: 160 },
        request: [100, 200],
        zoom: null,
        view: { start: 120, end: 160 }
    }
])('a view request $name is the line zoom within the viewport', async row => {
    const { viewport, request, zoom, view } = row;
    const { timeline, scopeLine } = await renderTimeline({ zoom: true });

    scopeLine.viewport.selection.setRanges(viewport && [viewport]);
    scopeLine.zoom.selection.setRange(130, 135);
    timeline.options.onViewChange(...request);

    assert.deepEqual(scopeLine.zoom.selection.ranges, zoom);
    assert.deepEqual(timeline.views.at(-1), view);
    scopeLine.viewport.resetRange();
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
    return {
        timeline,
        base,
        overlay,
        fonts,
        rect,
        flush,
        pending: () => Boolean(scheduled || layoutScheduled)
    };
}

function wheelOn(overlay, event) {
    let prevented = false;
    const wheelEvent = {
        clientX: 500,
        deltaX: 0,
        deltaY: 0,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        ...event,
        preventDefault() {
            prevented = true;
        }
    };

    overlay.listeners.get('wheel')(wheelEvent);

    return prevented;
}

test('an outside owned view zooms and pans by the wheel with a modifier or horizontally, otherwise scrolls the page', () => {
    const views = [];
    const onViewChange = (start, end) => views.push([start, end]);
    const { timeline, overlay } = createCanvasTimeline({ minX: 0, maxX: 1000, onViewChange });
    const view = [timeline.offsetMs, timeline.pxPerMs];

    // A vertical wheel scrolls the page and leaves the view
    assert.equal(wheelOn(overlay, { deltaY: -100 }), false);
    assert.deepEqual([timeline.offsetMs, timeline.pxPerMs], view);
    assert.deepEqual(views, []);

    // Zoom around the pointer is reported as the requested view
    for (const modifier of ['ctrlKey', 'metaKey']) {
        assert.equal(wheelOn(overlay, { deltaY: -Math.log(2) / 0.0015, [modifier]: true }), true);
    }
    assert.deepEqual(views.map(request => request.map(Math.round)), [[250, 750], [375, 625]]);

    assert.equal(wheelOn(overlay, { deltaX: 125, deltaY: 10 }), true);
    assert.deepEqual(views.at(-1).map(Math.round), [406, 656]);
    timeline.destroy();
});

test.each([
    { left: 0, clientX: 500 },
    { left: 200, clientX: 700 }
])('an outside owned view zooms around the pointer within the overlay at $left', row => {
    const views = [];
    const onViewChange = (start, end) => views.push([start, end]);
    const { timeline, overlay, rect } = createCanvasTimeline({ minX: 0, maxX: 1000, onViewChange });

    rect.left = row.left;
    wheelOn(overlay, { clientX: row.clientX, deltaY: -Math.log(2) / 0.0015, ctrlKey: true });

    assert.deepEqual(views.map(request => request.map(Math.round)), [[250, 750]]);
    timeline.destroy();
});

test('with Shift a vertical wheel scrolls the tracks of an outside owned view without a view request', () => {
    const views = [];
    const spans = Array.from({ length: 50 }, () => ({ start: 120, end: 180 }));
    const onViewChange = (start, end) => views.push([start, end]);
    const { timeline, overlay } = createCanvasTimeline({ spans, onViewChange });

    assert.equal(wheelOn(overlay, { deltaY: 30, shiftKey: true }), true);
    assert.equal(timeline.scrollY, 30);
    assert.deepEqual(views, []);
    timeline.destroy();
});

test('an outside view applies to the canvas once sized and keeps it on resize', () => {
    const { timeline, flush } = createCanvasTimeline({ minX: 0, maxX: 1000 });

    timeline.setView(250, 500);
    assert.equal(timeline.offsetMs, 250);
    assert.equal(timeline.pxPerMs, 4);
    flush();
    assert.equal(timeline.offsetMs, 250);

    timeline.width = 0;
    timeline.setView(100, 300);
    assert.equal(timeline.offsetMs, 250);
    timeline.resize();
    assert.equal(timeline.offsetMs, 100);
    assert.equal(timeline.pxPerMs, 5);
    timeline.destroy();
});

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
        assert.equal(timeline.tracks.includes(tracks[0]), !collapsed);
        assert.equal(timeline.tracks.at(-1), tracks[1]);
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
    timeline.setSelection([{ start: 10, end: 20 }]);
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
    timeline.setSpans([{ name: 'Earlier', spans: [{ start: -50, end: 300 }] }]);
    assert.deepEqual([timeline.minX, timeline.maxX], [-50, 300]);
    timeline.setSpans([]);
    flush();
    assert.deepEqual([timeline.minX, timeline.maxX, timeline.pxPerMs], [0, 1, 1000]);
    timeline.destroy();

    // A missing bound comes from the spans; an empty range is widened to one unit
    for (const [minX, maxX, spans, expected] of [
        [50, undefined, [{ start: 120, end: 180 }], [50, 180]],
        [undefined, 300, [], [299, 300]],
        [undefined, undefined, [{ start: 150, end: 150 }], [150, 151]]
    ]) {
        const { timeline } = createCanvasTimeline({ minX, maxX, spans });

        assert.deepEqual([timeline.minX, timeline.maxX], expected);
        timeline.destroy();
    }
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

    // The next track begins exactly at the bottom edge of the content area
    timeline.handleVerticalScroll(4);
    flush();
    assert.deepEqual(timeline.getVisibleTrackRange(), { start: 6, end: 10 });
    assert.equal(renderTrack.mock.calls.length, 4);
    timeline.destroy();
});

test('renders global intervals in z-order and skips those outside the viewport', () => {
    const { timeline, base, flush } = createCanvasTimeline({ intervals: [
        { start: 50, end: 90, color: '#a' },
        { start: 140, end: 160, color: '#b', zIndex: 1 },
        { start: 130, end: 170, color: '#c' },
        { start: 150, end: 150, color: '#d' },
        { offset: 120 }
    ] });
    const ctx = base.context;
    const draws = [];

    // Intervals span the 90px above the minimap; lines start at the top edge
    ctx.fillRect = vi.fn((x, y, width, height) => {
        if (height === 90) {
            draws.push([ctx.fillStyle, x, width]);
        }
    });
    ctx.moveTo = (x, y) => {
        if (y === 0) {
            draws.push([ctx.strokeStyle, x]);
        }
    };
    timeline.setSelection(null);
    flush();

    assert.deepEqual(draws, [['#888', 200.5], ['#c', 300, 400], ['#d', 500.5], ['#b', 400, 200]]);
    timeline.destroy();
});

test('group titles toggle and render only between the ruler and the minimap', () => {
    const names = ['First', 'Second', 'Third'];
    const open = scrollY => {
        const result = createCanvasTimeline({ groups: true, spans: names.map((name, index) => ({
            name, spans: [{ start: 120 + index * 10, end: 180 - index * 10 }]
        })) });

        result.timeline.handleVerticalScroll(scrollY);
        result.flush();
        return result;
    };

    // Titles start at offsets 0, 41 and 82; scrolled by 41 they occupy y -11..13, 30..54 and 71..95
    for (const [y, toggled] of [[10, []], [30, ['Second']], [54, []], [60, []], [89, ['Third']], [90, []]]) {
        const { timeline } = open(41);

        assert.equal(timeline.handleGroupTitleClick(10, y), toggled.length > 0);
        assert.deepEqual(timeline.groups.filter(group => group.collapsed).map(group => group.name), toggled);
        timeline.destroy();
    }

    // The first group ends at offset 40 and the third starts at 82: they touch the content edges at these scrolls
    for (const [scrollY, expected] of [[40, ['Second', 'Third']], [22, ['First', 'Second']]]) {
        const { timeline, base, flush } = open(scrollY);
        const titles = [];

        base.context.fillText = text => {
            if (names.includes(text)) {
                titles.push(text);
            }
        };
        timeline.setSelection(null);
        flush();

        assert.deepEqual(titles, expected);
        timeline.destroy();
    }
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
    // 20 tracks of 16px extend 260px beyond the 60px content area
    timeline.handleVerticalScroll(1000);
    flush();
    assert.equal(timeline.scrollY, 260);
    timeline.setSpans([{ start: 120, end: 180 }]);
    flush();
    assert.equal(timeline.scrollY, 0);
    assert.deepEqual(timeline.getVisibleTrackRange(), { start: 0, end: 1 });
    timeline.destroy();
});

test('hover reports changes once, highlights the displayed rectangle and resets on replacement or leave', () => {
    const onHover = vi.fn();
    const { timeline, overlay, flush } = createCanvasTimeline({ onHover });
    const [span] = timeline.tracks[0].spans;
    const other = { start: 150, end: 160 };
    const move = (clientX, clientY) => overlay.listeners.get('pointermove')({ clientX, clientY, stopPropagation() {} });

    move(300, 35);
    move(310, 40);
    assert.deepEqual(overlay.context.fillRect.mock.calls, [[200, 30, 600, 15]]);
    assert.deepEqual(overlay.context.strokeRect.mock.calls, [[200.5, 30.5, 599, 14]]);

    move(300, 60);
    timeline.setSpans([span]);
    flush();
    move(300, 35);
    timeline.setSpans([other]);
    flush();
    move(550, 35);
    overlay.listeners.get('pointerleave')({});

    assert.deepEqual(onHover.mock.calls.map(([hovered]) => hovered), [span, null, span, null, other, null]);
    timeline.destroy();
});

test('hit testing follows pixel edges of the displayed rectangles and the content area', () => {
    const fillers = Array.from({ length: 6 }, () => ({ start: 100, end: 200 }));
    const wide = { start: 110, end: 130 };
    const narrow = { start: 150, end: 150.2 };
    const last = { start: 190, end: 200 };
    const { timeline } = createCanvasTimeline({ spans: [...fillers, wide, narrow, last] }, 150);

    // Six full-width fillers take tracks 0-5; track 6 occupies y 126-141 and is cut by the minimap at y 140
    for (const [x, y, expected] of [
        [0, 30, fillers[0]],
        [100, 126, wide],
        [100, 139, wide],
        [100, 140, null],
        [299, 126, wide],
        [300, 126, null],
        // Rectangles narrower than 5px extend 2px, up to the next rectangle
        [503, 126, narrow],
        [504, 126, null],
        [520, 126, null],
        [999, 126, last]
    ]) {
        assert.equal(timeline.hitTest(x, y), expected, `${x}, ${y}`);
    }
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

    // Zoom stops where a pixel still resolves distinct coordinates at the far bound
    timeline.handleZoom(-1000000, 0);
    assert.equal(timeline.pxPerMs, 1 / (Number.EPSILON * 60000000));
    timeline.destroy();
});

test('ruler labels count from the lower bound unless absolute and include the last tick', () => {
    for (const [ruler, expected] of [
        ['relative', ['0ms', '10ms', '20ms', '30ms', '40ms', '50ms', '60ms', '70ms', '80ms', '90ms', '100ms']],
        ['absolute', ['100ms', '110ms', '120ms', '130ms', '140ms', '150ms', '160ms', '170ms', '180ms', '190ms', '200ms']]
    ]) {
        const { timeline, base } = createCanvasTimeline({ ruler });
        const labels = [];

        base.context.fillText = text => labels.push(text);
        timeline.renderRuler(base.context);

        assert.deepEqual(labels, expected);
        timeline.destroy();
    }
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
    const spans = [{ start: 0.26, end: 0.26 }, { start: 0.4, end: 0.41 }, { start: 3.4, end: 3.4 }];
    const onClick = vi.fn();
    const { timeline, base, overlay } = createCanvasTimeline({ spans, minX: 0, maxX: 2000, onClick }, 100, 2);
    const image = timeline.trackImages.get(timeline.tracks[0]);

    // At 0.5px/ms the first two spans share one marker; 3.4ms (x = 1.7) aligns down to the half-pixel grid
    assert.equal(base.width, 2000);
    assert.deepEqual(image.positions, [0, 1, 1.5, 2.5]);
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
    assert.deepEqual(ctx.fillText.mock.calls[0], ['X', 3, 8.5]);
    assert.equal(ctx.measureText.mock.calls.length, 0);
    timeline.renderSpan(ctx, span, 0, 0, 11);
    assert.equal(ctx.fillText.mock.calls.length, 1);

    assert.equal(timeline.hitTest(205, 35), span);
    fonts.dispatchEvent(new Event('loadingdone'));
    assert.equal(timeline.trackImages.size, 0);
    assert.equal(timeline.hitTest(205, 35), null);
    timeline.renderSpan(ctx, span, 0, 0, 13);
    assert.equal(ctx.measureText.mock.calls.length, 1);
    flush();
    assert.equal(timeline.hitTest(205, 35), span);
    timeline.destroy();
    fonts.dispatchEvent(new Event('loadingdone'));
    assert.equal(pending(), false);
});

test('fills spans with their own color or a stable hue of their text', () => {
    const { timeline, base } = createCanvasTimeline();
    const ctx = base.context;
    const fills = [];
    ctx.fillRect = () => fills.push(ctx.fillStyle);

    for (const span of [{ text: 'XY' }, { text: 'XY', color: '#123' }, {}]) {
        timeline.renderSpan(ctx, { start: 120, end: 121, ...span }, 0, 0, 4);
    }

    // 'XY' hashes to 88 * 31 + 89 = 2817, i.e. hue 297
    assert.deepEqual(fills, ['hsl(297, 30%, 40%, 80%)', '#123', 'hsl(0, 30%, 40%, 80%)']);
    timeline.destroy();
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

    // Width or DPR alone resizes the bitmap; a hidden, zero-width timeline draws no empty bitmap
    for (const [width, dpr, bitmap, draws] of [[800, 1, [800, 15], 2], [800, 2, [1600, 30], 2], [0, 2, [0, 30], 0]]) {
        timeline.width = width;
        timeline.dpr = dpr;
        base.context.drawImage.mockClear();
        timeline.setSelection(null);
        flush();
        assert.deepEqual([image.canvas.width, image.canvas.height], bitmap);
        assert.equal(base.context.drawImage.mock.calls.length, draws);
    }
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

test('a wheel gesture keeps its action until it pauses or its delta grows', () => {
    const now = vi.spyOn(Date, 'now');
    const { timeline, overlay } = createCanvasTimeline();
    const wheel = (time, deltaX, deltaY) => {
        now.mockReturnValue(time);
        overlay.listeners.get('wheel')({ clientX: 500, deltaX, deltaY, shiftKey: false, preventDefault() {} });
        return [timeline.pxPerMs, timeline.offsetMs];
    };

    const [zoomedScale, zoomedOffset] = wheel(1000, 0, -100);
    assert.deepEqual(wheel(1050, 30, 0), [zoomedScale, zoomedOffset]);

    const [scale, offset] = wheel(1100, 0, -100);
    assert.ok(scale > zoomedScale);
    assert.deepEqual(wheel(1400, 30, 0), [scale, offset + 30 / scale]);
    now.mockRestore();
    timeline.destroy();
});

test('renders the same absolute selection after local zoom and pan', () => {
    const onClick = vi.fn();
    const { timeline, base, overlay, flush } = createCanvasTimeline({ onClick });
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
    assert.equal(Math.round(overlay.context.fillRect.mock.calls[0][0] - start), 100);
    assert.deepEqual(base.context.fillRect.mock.calls.at(-1), [200, 90, 600, 10]);
    assert.deepEqual(selection, [{ start: 120, end: 180 }]);
    assert.equal(onClick.mock.calls.length, 0);
    timeline.destroy();
});
