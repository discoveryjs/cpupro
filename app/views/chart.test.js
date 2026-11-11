import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setRangeCoverage } from './misc/range-coverage.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { min, max } from '../prepare/misc/utils.js';
import { chartPointAt, chartScaleY, drawChart } from './chart/index.js';
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

    const chartOptions = {
        total: none,
        scaleY,
        ...options
    };

    drawChart(ctx, chartOptions, '#abc', dpr);
    assert.deepEqual(ctx.lineDash, []);

    return ctx.layers;
}

const samePosition = (a, b) => a[1] === b[1] && a[2] === b[2];
const xOf = vertex => vertex[1];
const yOf = vertex => vertex[2];

// Drawn vertices without repeats of the previous one
function vertices(path) {
    const result = [];

    for (let i = 0; i < path.length; i++) {
        if (i === 0 || !samePosition(path[i], path[i - 1])) {
            result.push(path[i]);
        }
    }

    return result;
}

test('scales values between paddings over a base at zero or below the minimum', () => {
    assert.deepEqual(scaleY.ticks.map(tick => tick.value), [10, 10 + 10 / 3, 10 + 20 / 3, 20]);
    assert.equal(scaleY.ticks[3].y, scaleY.y(20));
    assert.ok(scaleY.y(20) > 0);
    assert.ok(scaleY.y(20) < 5);
    assert.ok(scaleY.y(10) > 95);
    assert.ok(scaleY.y(10) < scaleY.base);
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

    assert.deepEqual(vertices(area.path).map(xOf), [-1000 / 3, 4000 / 3, 4000 / 3, -1000 / 3]);
    assert.deepEqual(vertices(area.path).map(yOf).slice(0, 2), [scaleY.y(12), scaleY.y(13)]);
});

test('does not extend a recording into a viewport after it', () => {
    const [, area] = draw({
        series,
        extent: { start: 110, end: 190 },
        viewport: { start: 200, end: 300 }
    });

    assert.ok(area.path.every(vertex => xOf(vertex) <= 0));
});

// Values of 1000 points: 20 at multiples of 7, otherwise 10 at multiples of 5, otherwise 15
function columnValue(i) {
    if (i % 7 === 0) {
        return 20;
    }

    if (i % 5 === 0) {
        return 10;
    }

    return 15;
}

test('draws the points of a pixel column by the range of their values and the last one', () => {
    const x = [];
    const y = [];

    for (let i = 0; i < 1000; i++) {
        x.push(i / 100);
        y.push(columnValue(i));
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
        const isColumnPoint = vertex => Math.floor(xOf(vertex)) === i;
        const columnYs = curve.filter(isColumnPoint).map(yOf);

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
    const join = curve.findIndex(vertex => xOf(vertex) === 500);
    const isFirstColumn = vertex => Math.floor(xOf(vertex)) === 0;

    assert.equal(xOf(curve[join - 1]).toFixed(6), '0.200000');
    assert.equal(yOf(curve[join - 1]), scaleY.y(15));
    assert.ok(curve.slice(0, join).every(isFirstColumn));
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

test('finds the point closest to a value of x', () => {
    const viewport = { start: 100, end: 200 };

    assert.deepEqual(chartPointAt(series, viewport, 130), { index: 0, x: 120, y: 10 });
    assert.deepEqual(chartPointAt(series, viewport, 140), { index: 1, x: 150, y: 20 });
    assert.deepEqual(chartPointAt(series, viewport, 190), { index: 2, x: 180, y: 15 });
    assert.deepEqual(chartPointAt(series, viewport, 100), { index: 0, x: 120, y: 10 });
    assert.equal(chartPointAt(none, viewport, 150), null);
});

test('marks a point beyond an edge of the viewport where the curve from it crosses the edge', () => {
    const between = { start: 155, end: 165 };
    const after = { start: 190, end: 200 };
    const before = { start: 100, end: 110 };

    assert.deepEqual(chartPointAt(series, between, 155), { index: 1, x: 155, y: 20 - 5 / 6 });
    assert.deepEqual(chartPointAt(series, between, 165), { index: 2, x: 165, y: 17.5 });

    // The curve extends by its edge values beyond the points
    assert.deepEqual(chartPointAt(series, after, 195), { index: 2, x: 190, y: 15 });
    assert.deepEqual(chartPointAt(series, before, 105), { index: 0, x: 110, y: 10 });
});

function createElement(tagName, className) {
    const listeners = new Map();
    const element = {
        tagName,
        className,
        clientWidth: 1000,
        hidden: false,
        textContent: '',
        children: [],
        styles: new Map(),
        classList: new Set(),
        style: {
            setProperty(name, value) {
                element.styles.set(name, value);
            }
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatch(type, event) {
            listeners.get(type)(event);
        },
        getContext() {
            return createContext(0, 0);
        },
        append(...children) {
            element.children.push(...children);
        }
    };

    return element;
}

// A line over 100–200
async function createLine() {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });

    return line;
}

// Renders a chart with a pixel ratio of 2; draws are recorded with the displayed range, frames are run by flush()
function renderView(config, data, context, computedColor = '#abc') {
    const frames = new Map();
    const draws = [];
    const observer = { observed: null };
    const tooltip = {
        el: { classList: new Set() },
        shown: [],
        hidden: 0,
        destroyed: false
    };
    const renders = [];
    let lastFrame = 0;
    let renderChart;
    let lifecycle;

    // A popup records the content renders it shows
    class Popup {
        constructor(options) {
            tooltip.el.classList.add(options.className);
            this.el = tooltip.el;
        }
        show(triggerEl, render) {
            tooltip.shown.push(render);
        }
        hide() {
            tooltip.hidden++;
        }
        destroy() {
            tooltip.destroyed = true;
        }
    }

    class ResizeObserver {
        constructor(callback) {
            observer.resize = width => callback([{ contentRect: { width } }]);
        }
        observe(el) {
            observer.observed = el;
        }
        disconnect() {
            observer.observed = null;
        }
    }

    // Copied out of the module's realm so deepEqual compares plain values
    const copySeries = series => ({ x: [...series.x], y: [...series.y] });
    const recordDraw = (ctx, options, color, dpr) => draws.push({
        series: copySeries(options.series),
        total: copySeries(options.total),
        viewport: { ...options.viewport },
        color,
        dpr
    });

    evaluateModule(new URL('./chart.js', import.meta.url), {
        discovery: {
            view: {
                define(name, render) {
                    renderChart = render;
                },
                Popup
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
        chartPointAt,
        drawChart: recordDraw,
        ResizeObserver,
        requestAnimationFrame(callback) {
            frames.set(++lastFrame, callback);
            return lastFrame;
        },
        cancelAnimationFrame(id) {
            frames.delete(id);
        },
        window: { devicePixelRatio: 2 },
        getComputedStyle: () => ({ getPropertyValue: () => computedColor }),
        utils: { createElement },
        HTMLElement: class {},
        customElements: { define: (name, Element) => lifecycle = { name, Element } },
        document: { createElement }
    });

    const element = createElement('div');
    const host = {
        render: (el, content, input, scope) => renders.push({ el, content, data: input, context: scope })
    };

    renderChart.call(host, element, config, data, context);

    return {
        element,
        canvas: element.children.find(child => child.tagName === 'canvas'),
        marker: element.children.find(child => child.className === 'marker'),
        labels: element.children.filter(child => child.classList.has('y-tick-label')),
        destroyEl: element.children.at(-1),
        lifecycle,
        frames,
        draws,
        observer,
        tooltip,
        // Connects the chart and sizes its canvas to the width
        show(width) {
            this.destroyEl.onConnect();
            observer.resize(width);
        },
        pointer(offsetX, offsetY = 0) {
            this.canvas.dispatch('pointermove', { offsetX, offsetY });
        },
        // Renders the content of the last shown tooltip
        describe() {
            const tooltipEl = { textContent: '' };

            tooltip.shown.at(-1)(tooltipEl);

            const rendered = renders.at(-1);

            if (typeof rendered.content === 'function') {
                rendered.content(tooltipEl, {}, rendered.data, rendered.context);
            }

            return {
                text: tooltipEl.textContent,
                data: rendered.data,
                content: rendered.content,
                context: rendered.context
            };
        },
        flush() {
            const pending = [...frames.values()];

            frames.clear();
            for (let i = 0; i < pending.length; i++) {
                pending[i]();
            }
        }
    };
}

const displayed = view => view.draws.at(-1).viewport;
const coverage = view => [view.element.styles.get('--range-pad-start'), view.element.styles.get('--range-pad-end')];
const labelText = label => label.textContent;
const labelTop = label => label.styles.get('--top');

test.each([
    {
        name: 'points of the config as objects',
        config: { points: [{ x: 120, y: 10 }, { x: 180, y: 20 }] },
        data: [[0, 0]]
    },
    {
        name: 'the data as pairs',
        config: {},
        data: [[120, 10], [180, 20]]
    }
])('draws the series of $name', row => {
    const view = renderView(row.config, row.data, {});

    view.show(100);

    assert.deepEqual(view.draws[0].series, { x: [120, 180], y: [10, 20] });
    assert.deepEqual(view.draws[0].total, { x: [], y: [] });
    assert.deepEqual(displayed(view), { start: 120, end: 180 });
});

test('draws the total of the config', () => {
    const view = renderView({ points: [[120, 10]], pointsTotal: [{ x: 150, y: 50 }] }, null, {});

    view.show(100);

    assert.deepEqual(view.draws[0].total, { x: [150], y: [50] });
});

test.each([
    {
        name: 'the points and the total',
        config: { pointsTotal: [[150, 50]] },
        viewport: { start: 120, end: 180 },
        labels: ['10.0', '23.3', '36.7', '50.0'],
        scale: chartScaleY(10, 50, 100)
    },
    {
        name: 'the config',
        config: {
            minX: 100,
            maxX: 200,
            minY: 15,
            maxY: 30
        },
        viewport: { start: 100, end: 200 },
        labels: ['15.0', '20.0', '25.0', '30.0'],
        scale: chartScaleY(15, 30, 100)
    }
])('the ranges of x and values are taken from $name', row => {
    const config = {
        ...row.config,
        height: 100,
        labelFormat: value => value.toFixed(1),
        points: [[120, 10], [150, 40], [180, 20]]
    };
    const view = renderView(config, null, {});

    view.show(100);

    assert.deepEqual(displayed(view), row.viewport);
    assert.deepEqual(view.labels.map(labelText), row.labels);
    assert.deepEqual(view.labels.map(labelTop), row.scale.ticks.map(tick => `${tick.y}px`));
});

test('labels have two fraction digits by default', () => {
    const view = renderView({ points: [[120, 10], [180, 20]] }, null, {});

    assert.deepEqual(view.labels.map(labelText), ['10.00', '13.33', '16.67', '20.00']);
});

test('a resize sizes the canvas to the pixel ratio and draws in the computed color at once', () => {
    const view = renderView({ height: 50, points: [[120, 10], [180, 20]] }, null, {});

    view.destroyEl.onConnect();
    assert.equal(view.observer.observed, view.canvas);
    assert.equal(view.draws.length, 0);

    view.observer.resize(300);
    assert.equal(view.canvas.style.height, '50px');
    assert.equal(view.canvas.width, 600);
    assert.equal(view.canvas.height, 100);
    assert.deepEqual(view.draws.map(draw => [draw.color, draw.dpr]), [['#abc', 2]]);
});

test('the color of the config is set to the element, a chart without a computed color is gray', () => {
    const view = renderView({ color: '#123', points: [[120, 10]] }, null, {}, '');

    view.show(100);

    assert.equal(view.element.styles.get('--color'), '#123');
    assert.equal(view.draws[0].color, '#888');
});

test.each([
    {
        name: 'the given extent',
        extent: { start: 120, end: 190 },
        coverage: [0.2, 0.1]
    },
    {
        name: 'the range of minX and maxX',
        extent: undefined,
        coverage: [0, 0]
    }
])('the coverage of $name is set over the displayed range', row => {
    const config = {
        minX: 100,
        maxX: 200,
        extent: row.extent,
        points: [[120, 10]]
    };
    const view = renderView(config, null, {});

    assert.deepEqual(coverage(view), row.coverage);
});

test('without zoom the range of minX and maxX is displayed and the line zoom is not followed', async () => {
    const line = await createLine();
    const view = renderView({ minX: 100, maxX: 200, points: [[120, 10]] }, null, { scopeLine: line });

    line.zoom.selection.setRange(110, 160);
    view.show(100);
    line.zoom.selection.setRange(120, 170);

    assert.deepEqual(displayed(view), { start: 100, end: 200 });
    assert.equal(view.frames.size, 0);
});

test('with zoom the line zoom is displayed, the coverage is over it', async () => {
    const line = await createLine();
    const config = {
        minX: 100,
        maxX: 200,
        extent: { start: 120, end: 200 },
        zoom: true,
        points: [[120, 10], [180, 20]]
    };
    const view = renderView(config, null, { scopeLine: line });

    line.zoom.selection.setRange(130, 180);
    assert.deepEqual(coverage(view), [0.2, 0]);

    view.show(100);
    assert.deepEqual(displayed(view), { start: 130, end: 180 });
    assert.deepEqual(coverage(view), [0, 0]);
});

test('with zoom a zoom change before the canvas is sized schedules no draw', async () => {
    const line = await createLine();
    const view = renderView({ zoom: true, points: [[120, 10]] }, null, { scopeLine: line });

    view.destroyEl.onConnect();
    line.zoom.selection.setRange(110, 160);

    assert.equal(view.frames.size, 0);
    assert.equal(view.draws.length, 0);
});

test('with zoom changes of the line zoom are drawn once on the next frame', async () => {
    const line = await createLine();
    const config = {
        extent: { start: 120, end: 200 },
        zoom: true,
        points: [[120, 10]]
    };
    const view = renderView(config, null, { scopeLine: line });

    view.show(100);
    line.zoom.selection.setRange(150, 200);
    line.zoom.selection.setRange(140, 190);
    assert.equal(view.draws.length, 1);
    assert.equal(view.frames.size, 1);
    assert.deepEqual(coverage(view), [0, 0]);

    view.flush();
    assert.deepEqual(displayed(view), { start: 140, end: 190 });
});

test('with zoom the line viewport is displayed without a zoom request', async () => {
    const line = await createLine();
    const view = renderView({ zoom: true, points: [[120, 10]] }, null, { scopeLine: line });

    view.show(100);
    line.viewport.selection.setRange(130, 170);
    view.flush();

    assert.deepEqual(displayed(view), { start: 130, end: 170 });
});

test('a resize draws at once instead of a scheduled draw', async () => {
    const line = await createLine();
    const view = renderView({ zoom: true, points: [[120, 10]] }, null, { scopeLine: line });

    view.show(100);
    line.zoom.selection.setRange(140, 190);
    view.observer.resize(200);

    assert.equal(view.frames.size, 0);
    assert.deepEqual(displayed(view), { start: 140, end: 190 });
});

test('destruction stops observing and following the zoom, cancels a draw and destroys the tooltip', async () => {
    const line = await createLine();
    const view = renderView({ zoom: true, points: [[120, 10]] }, null, { scopeLine: line });

    view.show(100);
    line.zoom.selection.setRange(140, 190);
    view.destroyEl.onDestroy();
    assert.equal(view.frames.size, 0);
    assert.equal(view.observer.observed, null);
    assert.equal(view.tooltip.destroyed, true);

    line.zoom.selection.setRange(110, 160);
    line.viewport.selection.setRange(120, 180);
    assert.equal(view.frames.size, 0);
});

// Points at 120 and 180 over 100–200 on a canvas 1000px wide; a total at 150 isn't a point
test.each([
    [400, 0, 0.2, 10],
    [400, 100, 0.2, 10],
    [490, 0, 0.2, 10],
    [510, 0, 0.8, 20]
])('a pointer at (%s, %s) marks the point at %s with the value %s', (offsetX, offsetY, left, value) => {
    const config = {
        minX: 100,
        maxX: 200,
        height: 100,
        points: [[120, 10], [180, 20]],
        pointsTotal: [[150, 30]]
    };
    const view = renderView(config, null, {});
    const scale = chartScaleY(10, 30, 100);

    assert.equal(view.marker.hidden, true);
    view.show(1000);
    view.pointer(offsetX, offsetY);

    assert.equal(view.marker.hidden, false);
    assert.equal(view.marker.styles.get('--left'), left);
    assert.equal(view.marker.styles.get('--top'), `${scale.y(value)}px`);
});

test('a tooltip describes the hovered point in the context with its offset from minX', () => {
    const config = {
        minX: 100,
        maxX: 200,
        labelFormat: value => value + 'b',
        points: [[120, 10], [180, 20]]
    };
    const view = renderView(config, null, { foo: 1 });

    view.show(1000);
    view.pointer(400);

    const { text, data, context } = view.describe();

    assert.equal(text, '10b');
    assert.deepEqual(data, [120, 10]);
    assert.deepEqual({ ...context }, { foo: 1, pointOffset: 20, edgeCrossing: null });
});

test('moving the pointer within the hovered point keeps its tooltip, another point shows its own', () => {
    const view = renderView({ minX: 100, maxX: 200, points: [[120, 10], [180, 20]] }, null, {});

    view.show(1000);
    view.pointer(400);
    view.pointer(420, 100);
    view.pointer(490);
    assert.equal(view.tooltip.shown.length, 1);

    view.pointer(510);
    assert.equal(view.tooltip.shown.length, 2);
    assert.deepEqual(view.describe().data, [180, 20]);
});

test('the pointer leaving the chart hides the marker and the tooltip', () => {
    const view = renderView({ minX: 100, maxX: 200, points: [[120, 10], [180, 20]] }, null, {});

    view.show(1000);
    view.pointer(400);

    const hidden = view.tooltip.hidden;

    view.canvas.dispatch('pointerleave');
    assert.equal(view.marker.hidden, true);
    assert.equal(view.tooltip.hidden, hidden + 1);
});

test('the tooltip has the class of the chart, a class and the content of the config', () => {
    const config = {
        minX: 100,
        maxX: 200,
        points: [[120, 10]],
        tooltipContent: 'text:y',
        tooltipClassName: 'custom'
    };
    const view = renderView(config, null, {});

    view.show(1000);
    view.pointer(150);

    assert.deepEqual([...view.tooltip.el.classList], ['view-cpupro-chart-tooltip', 'custom']);
    assert.equal(view.describe().content, 'text:y');
});

test('as the zoom moves a hovered point outside, the crossing of the edge is marked', async () => {
    const line = await createLine();
    const config = {
        minX: 100,
        maxX: 200,
        zoom: true,
        height: 100,
        points: [[120, 10], [180, 20]]
    };
    const view = renderView(config, null, { scopeLine: line });

    line.zoom.selection.setRange(115, 165);
    view.show(1000);
    view.pointer(150);
    assert.equal(view.describe().context.edgeCrossing, null);

    line.zoom.selection.setRange(140, 190);
    view.flush();
    assert.equal(view.tooltip.shown.length, 2);
    assert.equal(view.marker.styles.get('--left'), 0);
    assert.equal(view.marker.styles.get('--top'), `${chartScaleY(10, 20, 100).y(10 + 10 / 3)}px`);
    assert.deepEqual({ ...view.describe().context.edgeCrossing }, { offset: 40, value: 10 + 10 / 3 });
    assert.deepEqual(view.describe().data, [120, 10]);

    line.zoom.selection.setRange(141, 191);
    view.flush();
    assert.equal(view.tooltip.shown.length, 3);
    assert.equal(view.describe().context.edgeCrossing.offset, 41);
});

test('the destroy element calls its connect and destroy hooks once', () => {
    const { lifecycle } = renderView({ points: [] }, null, {});
    const element = new lifecycle.Element();
    const calls = [];

    element.onConnect = () => calls.push('connect');
    element.onDestroy = () => calls.push('destroy');
    element.connectedCallback();
    element.disconnectedCallback();

    assert.equal(lifecycle.name, 'destroy-cpupro-chart');
    assert.deepEqual(calls, ['connect', 'destroy']);
    assert.equal(element.onConnect, null);
    assert.equal(element.onDestroy, null);
});
