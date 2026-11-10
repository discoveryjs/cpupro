import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setRangeCoverage } from './misc/range-coverage.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { min, max } from '../prepare/misc/utils.js';
import { chartScaleY, drawChart } from './chart/index.js';
import usage from './chart.usage.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function createContext(width, height) {
    let path = null;

    return {
        canvas: { width, height },
        layers: [],
        lineDash: [],
        clearRect() {
            this.layers = [];
        },
        beginPath() {
            path = [];
        },
        moveTo(x, y) {
            path.push(['M', x, y]);
        },
        lineTo(x, y) {
            path.push(['L', x, y]);
        },
        setLineDash(dash) {
            this.lineDash = dash;
        },
        fill() {
            this.layers.push({ kind: 'fill', color: this.fillStyle, path });
        },
        stroke() {
            this.layers.push({ kind: 'stroke', color: this.strokeStyle, dash: this.lineDash, path });
        }
    };
}

const scaleY = chartScaleY(10, 20, 100);
const series = { x: [120, 150, 180], y: [10, 20, 15] };
const none = { x: [], y: [] };

function draw(options, width = 1000, dpr = 1) {
    const ctx = createContext(width * dpr, 100 * dpr);

    drawChart(ctx, { total: none, scaleY, ...options }, '#abc', dpr);
    assert.deepEqual(ctx.lineDash, []);

    return ctx.layers;
}

// Drawn vertices without repeats of the previous one
function vertices(path) {
    return path.filter(([, x, y], i) => i === 0 || x !== path[i - 1][1] || y !== path[i - 1][2]);
}

test('scales values between paddings over a base at zero or below the minimum', () => {
    assert.deepEqual(scaleY.ticks.map(tick => tick.value), [10, 10 + 10 / 3, 10 + 20 / 3, 20]);
    assert.equal(scaleY.ticks[3].y, scaleY.y(20));
    assert.ok(scaleY.y(20) > 0 && scaleY.y(20) < 5);
    assert.ok(scaleY.y(10) > 95 && scaleY.y(10) < scaleY.base);
    assert.equal(chartScaleY(0, 20, 100).base, chartScaleY(0, 20, 100).y(0));
    assert.ok(Number.isFinite(chartScaleY(5, 5, 100).y(5)));
});

test('fills the area to the coverage edges on the viewport scale over the ticks', () => {
    const [ticks, area] = draw({
        series,
        extent: { start: 110, end: 190 },
        viewport: { start: 100, end: 200 }
    });

    assert.equal(ticks.kind, 'stroke');
    assert.equal(ticks.path.length, 8);
    assert.equal(area.kind, 'fill');
    assert.equal(area.color, '#abc');
    assert.deepEqual(vertices(area.path), [
        ['M', 100, scaleY.y(10)],
        ['L', 200, scaleY.y(10)],
        ['L', 500, scaleY.y(20)],
        ['L', 800, scaleY.y(15)],
        ['L', 900, scaleY.y(15)],
        ['L', 900, scaleY.base],
        ['L', 100, scaleY.base]
    ]);
});

test('traces the points within the viewport and a neighbour beyond each edge', () => {
    const steps = { x: [100, 110, 120, 130, 140, 150], y: [10, 11, 12, 13, 14, 15] };
    const [, area] = draw({
        series: steps,
        extent: { start: 100, end: 150 },
        viewport: { start: 122, end: 128 }
    });

    assert.deepEqual(vertices(area.path).map(([, x]) => x), [-1000 / 3, 4000 / 3, 4000 / 3, -1000 / 3]);
    assert.deepEqual(vertices(area.path).map(([,, y]) => y).slice(0, 2), [scaleY.y(12), scaleY.y(13)]);
});

test('does not extend a recording into a viewport after it', () => {
    const [, area] = draw({
        series,
        extent: { start: 110, end: 190 },
        viewport: { start: 200, end: 300 }
    });

    assert.ok(area.path.every(([, x]) => x <= 0));
});

test('draws the points of a pixel column by the range of their values and the last one', () => {
    const x = [];
    const y = [];

    for (let i = 0; i < 1000; i++) {
        x.push(i / 100);
        y.push(i % 7 === 0 ? 20 : i % 5 === 0 ? 10 : 15);
    }

    const options = {
        series: { x, y },
        extent: { start: 0, end: 10 },
        viewport: { start: 0, end: 10 }
    };
    const [, area] = draw(options, 10);
    const curve = area.path.slice(1, -3);

    assert.ok(curve.length <= 10 * 4, curve.length);

    for (let i = 0; i < 10; i++) {
        const isColumnPoint = ([, px]) => Math.floor(px) === i;
        const columnYs = curve.filter(isColumnPoint).map(([,, py]) => py);

        assert.equal(Math.min(...columnYs), scaleY.y(20));
        assert.equal(Math.max(...columnYs), scaleY.y(10));
        assert.equal(columnYs.at(-1), scaleY.y(y[i * 100 + 99]));
    }
});

test('joins a column to the next one far away by their last and first points', () => {
    const [, area] = draw({
        series: { x: [100, 100.01, 100.02, 150], y: [10, 20, 15, 12] },
        extent: { start: 100, end: 150 },
        viewport: { start: 100, end: 200 }
    });
    const curve = vertices(area.path);
    const join = curve.findIndex(([, x]) => x === 500);

    assert.deepEqual([curve[join - 1][1].toFixed(6), curve[join - 1][2]], ['0.200000', scaleY.y(15)]);
    assert.ok(curve.slice(0, join).every(([, x]) => Math.floor(x) === 0));
    assert.deepEqual(curve[join], ['L', 500, scaleY.y(12)]);
});

test('strokes the total as a dashed line scaled by the pixel ratio', () => {
    const total = { x: [120, 180], y: [18, 20] };
    const options = {
        series,
        total,
        extent: { start: 110, end: 190 },
        viewport: { start: 100, end: 200 }
    };
    const line = draw(options, 1000, 2).at(-1);

    assert.equal(line.kind, 'stroke');
    assert.equal(line.color, '#abc');
    assert.deepEqual(line.dash, [8, 2]);
    assert.deepEqual(vertices(line.path), [
        ['M', 200, scaleY.y(18) * 2],
        ['L', 400, scaleY.y(18) * 2],
        ['L', 1600, scaleY.y(20) * 2],
        ['L', 1800, scaleY.y(20) * 2]
    ]);
});

function createElement(tagName) {
    const element = {
        tagName,
        children: [],
        styles: new Map(),
        classList: new Set(),
        style: {
            setProperty(name, value) {
                element.styles.set(name, value);
            }
        },
        getContext() {
            return createContext(0, 0);
        },
        append(...children) {
            this.children.push(...children);
        }
    };

    return element;
}

function renderView(config, context) {
    const frames = [];
    const draws = [];
    const observer = { observed: null };
    let renderChart;

    evaluateModule(new URL('./chart.js', import.meta.url), {
        discovery: {
            view: {
                define(name, render) {
                    renderChart = render;
                }
            }
        },
        usage,
        setRangeCoverage,
        resolveScopeProfileLine,
        lineZoom,
        subscribeLineZoom,
        min,
        max,
        chartScaleY,
        drawChart: (ctx, options) => draws.push({ ...options }),
        ResizeObserver: class {
            constructor(callback) {
                observer.resize = width => callback([{ contentRect: { width } }]);
            }
            observe(el) {
                observer.observed = el;
            }
            disconnect() {
                observer.observed = null;
            }
        },
        requestAnimationFrame: callback => frames.push(callback),
        cancelAnimationFrame() {},
        window: { devicePixelRatio: 2 },
        getComputedStyle: () => ({ getPropertyValue: () => '#abc' }),
        utils: { createElement },
        HTMLElement: class {},
        customElements: { define() {} },
        document: { createElement }
    });

    const element = createElement('div');

    renderChart(element, config, null, context);

    return {
        element,
        canvas: element.children.find(child => child.tagName === 'canvas'),
        destroyEl: element.children.at(-1),
        frames,
        draws,
        observer,
        flush() {
            const pending = frames.splice(0);

            for (let i = 0; i < pending.length; i++) {
                pending[i]();
            }
        }
    };
}

const viewport = view => ({ ...view.draws.at(-1).viewport });

test('zoom draws the line zoom within the coverage on the next frame until destroyed', async () => {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const view = renderView({
        minX: 100,
        maxX: 200,
        extent: { start: 120, end: 200 },
        zoom: true,
        height: 50,
        points: [{ x: 120, y: 10 }, { x: 180, y: 20 }]
    }, { scopeLine: line });
    const { element, canvas, destroyEl, draws, observer } = view;

    line.zoom.selection.setRange(110, 160);
    assert.equal(destroyEl.tagName, 'destroy-cpupro-chart');
    assert.equal(element.styles.get('--range-pad-start'), 0.2);

    destroyEl.onConnect();
    assert.equal(observer.observed, canvas);
    assert.equal(draws.length, 0);

    observer.resize(300);
    assert.equal(canvas.width, 600);
    assert.equal(canvas.height, 100);
    assert.deepEqual(viewport(view), { start: 110, end: 160 });

    line.zoom.selection.setRange(150, 200);
    line.zoom.selection.setRange(140, 190);
    assert.equal(draws.length, 1);
    assert.equal(view.frames.length, 1);
    assert.equal(element.styles.get('--range-pad-start'), 0);
    view.flush();
    assert.deepEqual(viewport(view), { start: 140, end: 190 });

    // Without a zoom request the viewport is displayed
    line.zoom.resetRange();
    line.viewport.selection.setRange(130, 170);
    view.flush();
    assert.deepEqual(viewport(view), { start: 130, end: 170 });
    line.viewport.resetRange();
    view.flush();

    destroyEl.onDestroy();
    assert.equal(observer.observed, null);
    line.zoom.selection.setRange(110, 160);
    line.viewport.selection.setRange(120, 180);
    assert.equal(view.frames.length, 0);
    line.zoom.resetRange();
    line.viewport.resetRange();
});

test('displays the range of minX and maxX without zoom', async () => {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const config = {
        minX: 100,
        maxX: 200,
        points: [{ x: 120, y: 10 }]
    };
    const view = renderView(config, { scopeLine: line });

    line.zoom.selection.setRange(110, 160);
    view.destroyEl.onConnect();
    view.observer.resize(100);
    assert.deepEqual(viewport(view), { start: 100, end: 200 });
    assert.equal(view.frames.length, 0);
    line.zoom.resetRange();
});

test('takes the ranges of x and values from the points unless given', () => {
    const points = [[120, 10], [150, 40], [180, 20]];
    const isLabel = child => child.classList.has('y-tick-label');
    const labels = view => view.element.children.filter(isLabel).map(label => label.textContent);
    const given = renderView({
        minX: 100,
        maxX: 200,
        minY: 15,
        maxY: 30,
        height: 100,
        labelFormat: String,
        points
    }, {});
    const own = renderView({
        height: 100,
        labelFormat: String,
        points,
        pointsTotal: [[150, 50]]
    }, {});

    given.destroyEl.onConnect();
    given.observer.resize(100);
    own.destroyEl.onConnect();
    own.observer.resize(100);

    assert.deepEqual(Array.from(given.draws.at(-1).series.y), [10, 40, 20]);
    assert.deepEqual(viewport(given), { start: 100, end: 200 });
    assert.deepEqual(labels(given), chartScaleY(15, 30, 100).ticks.map(tick => String(tick.value)));
    assert.deepEqual(viewport(own), { start: 120, end: 180 });
    assert.deepEqual(labels(own), chartScaleY(10, 50, 100).ticks.map(tick => String(tick.value)));
});
