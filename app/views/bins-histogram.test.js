import assert from 'node:assert/strict';
import { test } from 'vitest';
import { utils } from '@discoveryjs/discovery';
import { drawBinsHistogram, binsPerColumn } from './bins-histogram/index.js';
import usage from './bins-histogram.usage.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function createContext(width, height) {
    const ctx = {
        canvas: { width, height },
        layers: [],
        cleared: null,
        fillStyle: null,
        globalAlpha: 1,
        clearRect(...rect) {
            this.cleared = rect;
        },
        beginPath() {
            this.rects = [];
        },
        rect(...rect) {
            this.rects.push(rect);
        },
        fill() {
            this.layers.push({ color: this.fillStyle, alpha: this.globalAlpha, rects: this.rects });
        }
    };

    return ctx;
}

function draw(width, height, options, dpr = 1) {
    const ctx = createContext(width, height);

    drawBinsHistogram(ctx, options, '#abc', dpr);
    assert.deepEqual(ctx.cleared, [0, 0, width, height]);
    assert.equal(ctx.globalAlpha, 1);

    return ctx.layers;
}

function bars(width, height, options, dpr) {
    const layers = draw(width, height, options, dpr);

    assert.equal(layers.length, 1);
    assert.equal(layers[0].color, '#abc');
    assert.equal(layers[0].alpha, 1);

    return layers[0].rects;
}

const exact = values => values.map(value => Number(value.toFixed(3)));
const columns = rects => rects.map(rect => exact([rect[0], rect[2]]));
const heights = rects => rects.map(rect => rect[3]);
const rounded = rects => rects.map(exact);

test('columns sit at their exact positions from the bottom and skip empty bins', () => {
    assert.deepEqual(bars(10, 8, { bins: [1, 2, 0, 4, 3] }), [
        [0, 6, 1, 2],
        [2, 4, 1, 4],
        [6, 0, 1, 8],
        [8, 2, 1, 6]
    ]);

    // Uneven bin widths are not snapped to device pixels
    assert.deepEqual(columns(bars(8, 3, { bins: new Float64Array([1, 1, 1]) })), [
        [0, 1.667],
        [2.667, 1.667],
        [5.333, 1.667]
    ]);
});

test('columns keep the same gap however wide they are', () => {
    assert.deepEqual(columns(bars(6, 4, { bins: [1, 1] })), [[0, 2], [3, 2]]);
    assert.deepEqual(columns(bars(8, 4, { bins: [1, 1] })), [[0, 3], [4, 3]]);
    assert.deepEqual(columns(bars(22, 4, { bins: [1, 1] })), [[0, 10], [11, 10]]);

    // The gap is half a CSS pixel, at least a device pixel
    assert.deepEqual(columns(bars(8, 4, { bins: [1, 1] }, 0.5)), [[0, 3], [4, 3]]);
    assert.deepEqual(columns(bars(16, 4, { bins: [1, 1] }, 2)), [[0, 7], [8, 7]]);
    assert.deepEqual(columns(bars(24, 4, { bins: [1, 1] }, 3)), [[0, 10], [12, 10]]);
    assert.deepEqual(columns(bars(32, 4, { bins: [1, 1] }, 4)), [[0, 14], [16, 14]]);
});

test('bins merge by powers of two into columns keeping a bar at least as wide as their gap', () => {
    const bins = [1, 2, 3, 4, 5, 6, 7, 8];

    assert.equal(bars(16, 36, { bins }).length, 8);
    assert.deepEqual(columns(bars(14, 36, { bins })), [[0, 2.5], [3.5, 2.5], [7, 2.5], [10.5, 2.5]]);
    assert.deepEqual(heights(bars(14, 36, { bins })), [7, 17, 26, 36]);
    assert.deepEqual(columns(bars(7, 36, { bins })), [[0, 2.5], [3.5, 2.5]]);
    assert.deepEqual(heights(bars(7, 36, { bins })), [14, 36]);
    assert.deepEqual(columns(bars(3, 36, { bins })), [[0, 2]]);

    // The minimal width is in device pixels, two gaps: a CSS pixel at a pixel ratio of 2, still two CSS pixels at 1
    assert.equal(bars(16, 36, { bins }, 2).length, 8);
    assert.equal(bars(14, 36, { bins }, 2).length, 4);
    assert.equal(bars(24, 36, { bins }, 3).length, 4);
    assert.equal(bars(32, 36, { bins }, 3).length, 8);

    // A last incomplete column sums fewer bins and is clipped by the canvas edge
    assert.deepEqual(rounded(bars(8, 6, { bins: [1, 1, 1, 1, 1] })), [
        [0, 0, 2.2, 6],
        [3.2, 0, 2.2, 6],
        [6.4, 3, 1.6, 3]
    ]);
});

test('a canvas without width draws nothing and a narrow one merges all bins into a single column', () => {
    assert.deepEqual(bars(0, 4, { bins: [1, 2, 3] }), []);
    assert.equal(bars(3, 4, { bins: new Array(49).fill(1) }).length, 1);
});

test('no more than 500 columns are shown however wide the canvas is', () => {
    const bins = new Uint8Array(2000).fill(1);

    assert.equal(bars(4000, 4, { bins }).length, 500);
    assert.equal(bars(4000, 4, { bins: bins.subarray(0, 1000) }).length, 500);
    assert.equal(bars(4000, 4, { bins: bins.subarray(0, 1001) }).length, 251);
    assert.equal(bars(4000, 4, { bins: bins.subarray(0, 500) }).length, 500);
});

test('merged columns compare with the sum of the maximums of their bins', () => {
    const bins = [1, 4, 2, 2, 0, 8, 3, 1];

    assert.deepEqual(heights(bars(8, 8, { bins })), [5, 4, 8, 4]);
    assert.deepEqual(heights(bars(8, 20, { bins, max: 5 })), [10, 8, 16, 8]);
    assert.deepEqual(heights(bars(16, 20, { bins, max: 5 })), [4, 16, 8, 8, 32, 12, 4]);
    assert.deepEqual(heights(bars(4, 20, { bins, max: 5 })), [9, 12]);
});

test('merged columns of peaks show the highest peak and compare with the maximum of a bin', () => {
    const bins = [1, 4, 2, 2, 0, 8, 3, 1];

    assert.deepEqual(heights(bars(8, 8, { bins, peaks: true })), [4, 2, 8, 3]);
    assert.deepEqual(heights(bars(8, 8, { bins, peaks: true, max: 16 })), [2, 1, 4, 2]);
    assert.deepEqual(heights(bars(16, 8, { bins, peaks: true })), [1, 4, 2, 2, 8, 3, 1]);
    // A last incomplete column has the highest of its fewer peaks
    assert.deepEqual(rounded(bars(4, 4, { bins: [1, 4, 2], peaks: true })), [[0, 0, 1.667, 4], [2.667, 2, 1.333, 2]]);

    // The own shape of peaks uses the highest peaks as well
    assert.deepEqual(draw(8, 8, { bins, peaks: true, max: 16, binsMax: true }).map(layer => heights(layer.rects)), [
        [4, 2, 8, 3],
        [2, 1, 4, 2]
    ]);
    assert.equal(draw(8, 8, { bins, peaks: true, max: 8.5, binsMax: true }).length, 1);

    // Presence keeps a column of zero peaks visible
    assert.deepEqual(bars(2, 10, { bins: [0, 0], presence: [0, 1], peaks: true }), [[0, 9, 1, 1]]);
});

test('tracks splitting a total keep their shares in merged columns', () => {
    const max = 1;
    const tracks = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

    for (let i = 0; i < tracks.length; i++) {
        assert.deepEqual(bars(2, 4, { bins: tracks[i], max }), [[0, 3, 1, 1]]);
    }
});

test('without a maximum of a bin, columns scale to the highest visible column', () => {
    const bins = [9, 0, 0, 0, 1, 1, 2, 0];
    const range = { start: 0, end: 80 };
    const viewport = { start: 40, end: 80 };

    // Bins beyond the viewport don't change the scale
    assert.deepEqual(bars(8, 8, { bins, range, viewport }), [
        [0, 4, 1, 4],
        [2, 4, 1, 4],
        [4, 0, 1, 8]
    ]);
    assert.deepEqual(bars(8, 8, { bins: [0, 0, 0, 0, 1, 1, 2, 0], range, viewport }), [
        [0, 4, 1, 4],
        [2, 4, 1, 4],
        [4, 0, 1, 8]
    ]);
    assert.deepEqual(heights(bars(8, 8, { bins, range, viewport: { start: 30, end: 70 } })), [4, 4, 8]);
    assert.deepEqual(heights(bars(4, 8, { bins, range, viewport })), [8, 8]);
    assert.deepEqual(heights(bars(4, 8, { bins, range, viewport: { start: 0, end: 40 } })), [8]);
    // Neither do bins right after the viewport
    const highAfter = [1, 1, 2, 0, 9, 0, 0, 0];

    assert.deepEqual(heights(bars(8, 8, { bins: highAfter, range, viewport: { start: 0, end: 40 } })), [4, 4, 8]);

    // A partially visible column counts with its whole value
    assert.deepEqual(heights(bars(16, 8, { bins, range, viewport: { start: 5, end: 45 } })), [8, 1]);

    // A maximum of a bin keeps the scale of the whole range
    assert.deepEqual(heights(bars(8, 9, { bins, range, viewport, max: 9 })), [1, 1, 2]);
});

test('series sharing the scale make the highest of their visible columns the full height', () => {
    const range = { start: 0, end: 80 };
    const viewport = { start: 40, end: 80 };
    const total = [20, 0, 0, 0, 4, 2, 2, 0];
    const bins = [10, 0, 0, 0, 2, 1, 1, 0];
    const peak = [0, 0, 0, 0, 0, 0, 8, 0];

    assert.deepEqual(heights(bars(8, 8, { bins, range, viewport, scaleBins: [total] })), [4, 2, 2]);
    assert.deepEqual(heights(bars(8, 8, { bins, range, viewport: { start: 0, end: 40 }, scaleBins: [total] })), [4]);

    // The highest of several series, merged into the same columns
    assert.deepEqual(heights(bars(8, 8, { bins, range, viewport, scaleBins: [peak, total] })), [2, 1, 1]);
    assert.deepEqual(heights(bars(4, 8, { bins, range, viewport, scaleBins: [total] })), [4, 1]);

    // A maximum of a bin takes precedence
    const capped = {
        bins,
        range,
        viewport,
        scaleBins: [total],
        max: 2
    };

    assert.deepEqual(heights(bars(8, 8, capped)), [8, 4, 4]);

    // Columns far below the shared scale show their own shape behind
    const layers = draw(8, 8, {
        bins,
        range,
        viewport,
        scaleBins: [total],
        binsMax: true
    });

    assert.deepEqual(layers.map(layer => heights(layer.rects)), [
        [8, 4, 4],
        [4, 2, 2]
    ]);
});

test('maximums of a column duration over all data are the full height of columns and shadows anywhere', () => {
    const range = { start: 5, end: 85 };
    const bins = [10, 0, 0, 0, 2, 1, 1, 0];
    const durations = [];
    const scaleMax = (duration, start) => {
        durations.push([duration, start]);
        return 20;
    };
    const binsMax = () => 10;
    const layers = (width, viewport) => draw(width, 20, {
        bins,
        range,
        viewport,
        scaleMax,
        binsMax
    }).map(layer => heights(layer.rects));

    // Panning keeps both scales, whichever columns are visible: the shadow, then the columns
    assert.deepEqual(layers(8, { start: 45, end: 85 }), [[4, 2, 2], [2, 1, 1]]);
    assert.deepEqual(layers(8, { start: 5, end: 45 }), [[20], [10]]);
    // Bins merged by 2 on a narrower canvas are columns of a twice longer duration, from the start of the bins
    layers(4, { start: 45, end: 85 });
    assert.deepEqual(durations, [[10, 5], [10, 5], [20, 5]]);
});

test('the viewport places columns aligned to their bins and clips the edges', () => {
    const bins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const range = { start: 100, end: 200 };

    assert.deepEqual(bars(20, 10, { bins, range }), bars(20, 10, { bins, range, viewport: range }));
    assert.deepEqual(bars(15, 10, { bins, range, viewport: { start: 150, end: 200 } }), [
        [0, 4, 2, 6],
        [3, 3, 2, 7],
        [6, 2, 2, 8],
        [9, 1, 2, 9],
        [12, 0, 2, 10]
    ]);

    // Partially visible columns are clipped, columns outside are skipped
    assert.deepEqual(bars(15, 10, { bins, range, viewport: { start: 125, end: 175 } }), [
        [0, 6, 0.5, 4],
        [1.5, 5, 2, 5],
        [4.5, 4, 2, 6],
        [7.5, 2, 2, 8],
        [10.5, 1, 2, 9],
        [13.5, 0, 1.5, 10]
    ]);

    // A column clipped within its gap is not drawn
    assert.deepEqual(rounded(bars(15, 10, { bins, range, viewport: { start: 128, end: 178 } })).slice(0, 2), [
        [0.6, 5, 2, 5],
        [3.6, 4, 2, 6]
    ]);

    // Merged columns start at multiples of their size and keep their value when partially visible
    assert.deepEqual(rounded(bars(10, 19, { bins, range, viewport: { start: 110, end: 200 } })), [
        [0, 16, 0.111, 3],
        [1.111, 12, 1.222, 7],
        [3.333, 8, 1.222, 11],
        [5.556, 4, 1.222, 15],
        [7.778, 0, 1.222, 19]
    ]);

    // A viewport beyond the range shows its uncovered part empty
    assert.deepEqual(columns(bars(20, 10, { bins, range, viewport: { start: 50, end: 150 } })), [
        [10, 1], [12, 1], [14, 1], [16, 1], [18, 1]
    ]);
    assert.deepEqual(bars(20, 10, { bins, range, viewport: { start: 200, end: 300 } }), []);
});

test('zooming in moves columns continuously and splits merged columns keeping the gap', () => {
    const bins = new Uint8Array(16).fill(1);
    const range = { start: 0, end: 16 };

    assert.equal(bars(8, 1, { bins, range }).length, 4);
    assert.equal(bars(8, 1, { bins, range, viewport: { start: 0, end: 15 } }).length, 4);
    assert.equal(bars(8, 1, { bins, range, viewport: { start: 0, end: 8 } }).length, 4);
    assert.equal(bars(8, 1, { bins, range, viewport: { start: 0, end: 7 } }).length, 4);
    assert.equal(bars(8, 1, { bins, range, viewport: { start: 0, end: 4 } }).length, 4);
    assert.deepEqual(columns(bars(8, 1, { bins, range, viewport: { start: 0, end: 4 } })), [
        [0, 1], [2, 1], [4, 1], [6, 1]
    ]);

    // Between splits columns widen with the zoom and keep their gap
    assert.deepEqual(columns(bars(16, 1, { bins, range, viewport: { start: 0, end: 16 } })), [
        [0, 1], [2, 1], [4, 1], [6, 1], [8, 1], [10, 1], [12, 1], [14, 1]
    ]);
    assert.deepEqual(columns(bars(16, 1, { bins, range, viewport: { start: 0, end: 12.8 } })), [
        [0, 1.5], [2.5, 1.5], [5, 1.5], [7.5, 1.5], [10, 1.5], [12.5, 1.5], [15, 1]
    ]);
});

test('degenerate ranges and viewports place bins across the canvas', () => {
    const bins = [1, 2];

    for (const placement of [
        { range: { start: 10, end: 10 }, viewport: { start: 0, end: 5 } },
        { range: { start: 0, end: 10 }, viewport: { start: 5, end: 5 } },
        { range: null, viewport: { start: 0, end: 5 } }
    ]) {
        assert.deepEqual(bars(4, 2, { bins, ...placement }), [[0, 1, 1, 1], [2, 0, 1, 2]]);
    }
});

test('present and small columns keep a minimal height scaled to the pixel ratio', () => {
    const options = { bins: [0, 1, 0, 100], presence: new Uint8Array([0, 0, 1, 0]) };

    assert.deepEqual(bars(8, 10, options, 1), [
        [2, 9, 1, 1],
        [4, 9, 1, 1],
        [6, 0, 1, 10]
    ]);
    assert.deepEqual(heights(bars(8, 10, options, 0.5)), [1, 1, 10]);
    assert.deepEqual(heights(bars(16, 10, options, 2)), [2, 2, 10]);
    assert.deepEqual(heights(bars(24, 10, options, 3)), [2, 2, 10]);
    assert.deepEqual(heights(bars(32, 10, options, 4)), [3, 3, 10]);

    // Presence of any merged bin keeps the column visible
    assert.deepEqual(bars(2, 10, { bins: [0, 0], presence: [0, 1] }), [[0, 9, 1, 1]]);
});

test('heights follow the scale and an explicit maximum', () => {
    const bins = [0, 3, 15, 63];

    assert.deepEqual(heights(bars(8, 12, { bins, max: 126 })), [1, 1, 6]);
    assert.deepEqual(heights(bars(8, 12, { bins, scale: 'linear' })), [1, 3, 12]);
    assert.deepEqual(heights(bars(8, 12, { bins, scale: 'log' })), [4, 8, 12]);
    assert.deepEqual(heights(bars(8, 12, { bins, scale: 'sqrt' })), [3, 6, 12]);
});

test('bins without a positive maximum draw only their presence', () => {
    for (const scale of ['linear', 'log', 'sqrt']) {
        assert.deepEqual(bars(6, 4, { bins: [0, 0, 0], presence: [0, 1, 0], scale }), [[2, 3, 1, 1]]);
        assert.deepEqual(bars(6, 4, { bins: [], scale }), []);
    }
});

test('columns far below a shared maximum show their own shape behind', () => {
    const presence = [1, 0, 0, 0];
    const [relative, shared] = draw(8, 10, { bins: [0, 2, 4, 8], presence, max: 20, binsMax: true });

    assert.deepEqual(relative, { color: '#abc', alpha: 0.4, rects: [
        [2, 7, 1, 3],
        [4, 5, 1, 5],
        [6, 0, 1, 10]
    ] });
    assert.deepEqual(shared, { color: '#abc', alpha: 1, rects: [
        [0, 9, 1, 1],
        [2, 9, 1, 1],
        [4, 8, 1, 2],
        [6, 6, 1, 4]
    ] });

    // Close to the shared maximum, without it or when not requested only the shared columns remain
    assert.equal(draw(8, 10, { bins: [0, 2, 4, 9], max: 10, binsMax: true }).length, 1);
    assert.equal(draw(8, 10, { bins: [0, 2, 4, 8.99], max: 10, binsMax: true }).length, 2);
    assert.equal(draw(8, 10, { bins: [0, 2, 4, 8], binsMax: true }).length, 1);
    assert.equal(draw(8, 10, { bins: [0, 2, 4, 8], max: 20 }).length, 1);

    // Merged columns compare with the shared maximum of the same number of bins
    assert.deepEqual(draw(4, 10, { bins: [0, 2, 4, 8], max: 7, binsMax: true }).map(layer => layer.rects), [
        [[0, 8, 1, 2], [2, 0, 1, 10]],
        [[0, 9, 1, 1], [2, 1, 1, 9]]
    ]);
    assert.equal(draw(4, 10, { bins: [0, 2, 4, 8], max: 6.6, binsMax: true }).length, 1);
});

function renderHistogram(config, data, options = {}) {
    const { dpr = 2, color = '', context = {} } = options;
    const frames = new Map();
    let lastFrame = 0;
    const elements = [];
    const drawn = [];
    const observed = [];
    let render;
    let lifecycle;
    let resize;
    const el = {
        style: new Map(),
        children: [],
        append(...children) {
            this.children.push(...children);
        }
    };
    el.style.setProperty = el.style.set;

    // An inherited color when given, otherwise the own color of the element
    const getPropertyValue = (element, name) => {
        if (element !== el || name !== '--color') {
            return '';
        }

        return color || el.style.get('--color') || '';
    };

    evaluateModule(new URL('./bins-histogram.js', import.meta.url), {
        utils: {
            isArray: utils.isArray,
            createElement(tagName) {
                const element = { tagName, style: {}, getContext: () => ({ canvas: element }) };

                elements.push(element);
                return element;
            }
        },
        drawBinsHistogram(ctx, options, color, dpr) {
            drawn.push({
                canvas: ctx.canvas,
                options,
                viewport: options.viewport,
                color,
                dpr,
                width: ctx.canvas.width,
                height: ctx.canvas.height
            });
        },
        usage,
        discovery: {
            view: {
                define(_, callback, options) {
                    render = callback;
                    assert.equal(options.usage, usage);
                }
            }
        },
        ResizeObserver: class {
            constructor(callback) {
                resize = callback;
            }
            observe(element) {
                observed.push(element);
            }
            disconnect() {
                observed.length = 0;
            }
        },
        window: { devicePixelRatio: dpr },
        requestAnimationFrame(callback) {
            frames.set(++lastFrame, callback);
            return lastFrame;
        },
        cancelAnimationFrame: id => frames.delete(id),
        getComputedStyle: element => ({
            getPropertyValue: name => getPropertyValue(element, name)
        }),
        HTMLElement: class {},
        customElements: {
            define(name, Element) {
                lifecycle = { name, Element };
            }
        }
    });

    render(el, config, data, context);

    const [canvas, destroyEl] = elements;
    const lifecycleElement = Object.assign(new lifecycle.Element(), destroyEl);

    assert.equal(lifecycle.name, 'destroy-bins-histogram');
    assert.equal(destroyEl.tagName, 'destroy-bins-histogram');
    assert.deepEqual(el.children, [canvas, destroyEl]);

    return {
        el,
        canvas,
        drawn,
        observed,
        frames,
        nextFrame() {
            const callbacks = [...frames.values()];

            frames.clear();

            for (let i = 0; i < callbacks.length; i++) {
                callbacks[i]();
            }
        },
        connect: () => lifecycleElement.connectedCallback(),
        disconnect: () => lifecycleElement.disconnectedCallback(),
        resize: width => resize([{ contentRect: { width } }])
    };
}

test('draws on a canvas sized to its CSS box and pixel ratio while connected', () => {
    const bins = [1, 2, 3];
    const presence = [0, 1, 0];
    const config = {
        bins,
        presence,
        max: 5,
        binsMax: true,
        scale: 'log',
        height: 30
    };
    const histogram = renderHistogram(config, null, { dpr: 1.5 });

    assert.equal(histogram.canvas.tagName, 'canvas');
    assert.equal(histogram.canvas.style.height, '30px');
    assert.deepEqual(histogram.observed, []);

    histogram.connect();
    assert.deepEqual(histogram.observed, [histogram.canvas]);
    assert.deepEqual(histogram.drawn, []);

    histogram.resize(100.4);
    histogram.resize(201);
    assert.deepEqual(histogram.drawn.map(draw => [draw.canvas, draw.width, draw.height, draw.dpr]), [
        [histogram.canvas, 151, 45, 1.5],
        [histogram.canvas, 302, 45, 1.5]
    ]);
    assert.deepEqual({ ...histogram.drawn[0].options }, {
        bins,
        range: undefined,
        viewport: undefined,
        presence,
        peaks: undefined,
        max: 5,
        scaleBins: undefined,
        scaleMax: undefined,
        binsMax: true,
        scale: 'log'
    });
    assert.equal(histogram.drawn[1].options, histogram.drawn[0].options);

    histogram.disconnect();
    assert.deepEqual(histogram.observed, []);
});

test('bins come from config or data and the color from the element style', () => {
    const data = new Uint32Array([1, 2]);
    const fromData = renderHistogram({}, data, { dpr: null });

    fromData.connect();
    fromData.resize(10);
    assert.equal(fromData.drawn[0].options.bins, data);
    assert.equal(fromData.drawn[0].color, '#888');
    assert.deepEqual([fromData.drawn[0].width, fromData.drawn[0].height, fromData.drawn[0].dpr], [10, 20, 1]);
    assert.equal(fromData.canvas.style.height, '20px');
    assert.equal(fromData.el.style.has('--color'), false);

    const fromConfig = renderHistogram({ bins: [3], color: '#123' }, data);

    fromConfig.connect();
    fromConfig.resize(10);
    assert.deepEqual(fromConfig.drawn[0].options.bins, [3]);
    assert.equal(fromConfig.el.style.get('--color'), '#123');
    assert.equal(fromConfig.drawn[0].color, '#123');

    const inherited = renderHistogram({ bins: { length: 1 } }, data, { color: 'red' });

    inherited.connect();
    inherited.resize(10);
    assert.deepEqual([...inherited.drawn[0].options.bins], []);
    assert.equal(inherited.drawn[0].color, 'red');
});

test('passes the range and viewport of bins and their peaks to drawing', () => {
    const range = { start: 0, end: 10 };
    const viewport = { start: 2, end: 6 };
    const histogram = renderHistogram({ bins: [1], range, viewport, peaks: true }, null);

    histogram.connect();
    histogram.resize(10);
    assert.equal(histogram.drawn[0].options.range, range);
    assert.equal(histogram.drawn[0].viewport, viewport);
    assert.equal(histogram.drawn[0].options.peaks, true);
});

test('onInit receives an API to follow a changing viewport with one draw per frame', () => {
    const data = [1, 2];
    const context = { context: true };
    const calls = [];
    let api;
    const onInit = (...args) => {
        calls.push(args);
        api = args[0];

        return () => calls.push('cleanup');
    };
    const histogram = renderHistogram({ bins: [1], onInit }, data, { context });

    assert.deepEqual(calls, []);
    histogram.connect();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(1), [data, context]);

    // Before the canvas is sized its first draw takes the latest viewport
    api.setViewport({ start: 1, end: 2 });
    assert.equal(histogram.frames.size, 0);
    histogram.resize(10);
    assert.deepEqual(histogram.drawn.map(draw => draw.viewport), [{ start: 1, end: 2 }]);

    api.setViewport({ start: 2, end: 3 });
    api.setViewport({ start: 3, end: 4 });
    assert.equal(histogram.frames.size, 1);
    assert.equal(histogram.drawn.length, 1);
    histogram.nextFrame();
    assert.deepEqual(histogram.drawn.map(draw => draw.viewport).slice(1), [{ start: 3, end: 4 }]);

    // A resize draws immediately and drops the scheduled frame
    api.setViewport({ start: 4, end: 5 });
    histogram.resize(20);
    assert.equal(histogram.frames.size, 0);
    assert.deepEqual(histogram.drawn.map(draw => [draw.width, draw.viewport]).slice(2), [[40, { start: 4, end: 5 }]]);

    api.setViewport({ start: 5, end: 6 });
    histogram.disconnect();
    assert.equal(histogram.frames.size, 0);
    assert.deepEqual(calls.slice(1), ['cleanup']);
    assert.equal(histogram.drawn.length, 3);
});

test('bins per column match the columns drawn on a canvas of the same CSS width and pixel ratio', () => {
    assert.equal(binsPerColumn(500, 2000, 1360, 1), 1);
    assert.equal(binsPerColumn(2000, 2000, 1360, 1), 4);
    assert.equal(binsPerColumn(1000, 2000, 1360, 1), 2);
    assert.equal(binsPerColumn(500, 2000, 1000, 1), 1);
    assert.equal(binsPerColumn(500, 2000, 999, 1), 2);
    assert.equal(binsPerColumn(8, 8, 0, 1), 8);

    // All bins of a window without zoom fit 500 columns on a narrower canvas of a higher pixel ratio
    assert.equal(binsPerColumn(2000, 2000, 840, 1), 8);
    assert.equal(binsPerColumn(2000, 2000, 840, 2), 4);
    assert.equal(binsPerColumn(2000, 2000, 499, 2), 8);

    const cases = [[1360, 1], [1360, 2], [700, 1.5], [999, 1], [840, 2]];

    for (let i = 0; i < cases.length; i++) {
        const [width, dpr] = cases[i];
        const bins = new Uint8Array(2000).fill(1);
        const columns = bars(Math.round(width * dpr), 4, { bins }, dpr).length;

        assert.equal(columns, 2000 / binsPerColumn(2000, 2000, width, dpr));
    }
});
