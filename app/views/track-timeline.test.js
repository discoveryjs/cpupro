import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, test, vi } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { TrackTimeline as CanvasTrackTimeline } from './track-timeline/index.js';

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

function createCanvasTimeline(options = {}) {
    let scheduled;
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('ResizeObserver', class {
        observe() {} disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', callback => {
        scheduled = callback;
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => scheduled = null);
    const rect = { left: 0, top: 0, width: 1000, height: 100 };
    const createCanvas = () => {
        const context = {
            fillRect: vi.fn(), strokeRect: vi.fn(), clearRect: vi.fn(),
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
    const timeline = new CanvasTrackTimeline({
        querySelector: selector => selector.endsWith('__canvas') ? base : overlay,
        getBoundingClientRect: () => rect
    }, { minX: 100, maxX: 200, spans: [{ start: 120, end: 180 }], ...options });
    const flush = () => {
        base.context.fillRect.mockClear();
        overlay.context.fillRect.mockClear();
        if (scheduled) {
            const callback = scheduled;
            scheduled = null;
            callback();
        }
    };
    flush();
    return { timeline, base, overlay, flush };
}

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
