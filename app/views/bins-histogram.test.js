import assert from 'node:assert/strict';
import { test } from 'vitest';
import { utils } from '@discoveryjs/discovery';
import { drawBinsHistogram } from './bins-histogram/index.js';
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

test('bars cover whole device pixels from the bottom and skip empty bins', () => {
    assert.deepEqual(bars(10, 8, { bins: [1, 2, 0, 4, 3] }), [
        [0, 6, 2, 2],
        [2, 4, 2, 4],
        [6, 0, 2, 8],
        [8, 2, 2, 6]
    ]);

    // Uneven bin widths still end exactly at the canvas edge
    assert.deepEqual(bars(8, 3, { bins: new Float64Array([1, 1, 1]) }).map(([x,, w]) => [x, w]), [
        [0, 2],
        [2, 3],
        [5, 3]
    ]);
});

test('bars are separated by a tenth of their width when at least four pixels wide', () => {
    assert.deepEqual(bars(6, 4, { bins: [1, 1] }).map(([x,, w]) => [x, w]), [[0, 3], [3, 3]]);
    assert.deepEqual(bars(8, 4, { bins: [1, 1] }).map(([x,, w]) => [x, w]), [[0, 3], [4, 3]]);
    assert.deepEqual(bars(22, 4, { bins: [1, 1] }).map(([x,, w]) => [x, w]), [[0, 9], [11, 9]]);
});

test('bins narrower than a pixel share it and show their maximum', () => {
    assert.deepEqual(bars(2, 4, { bins: [1, 4, 2, 0] }), [
        [0, 0, 1, 4],
        [1, 2, 1, 2]
    ]);

    // A bin belongs to the pixel where it ends; an empty pixel draws nothing
    assert.deepEqual(bars(2, 4, { bins: [4, 2, 0] }), [
        [0, 0, 1, 4]
    ]);
    assert.deepEqual(bars(2, 4, { bins: [0, 0, 2] }), [
        [1, 0, 1, 4]
    ]);

    // The last bin ends exactly at the canvas edge, where a fractional bin width falls short of it
    assert.deepEqual(bars(1, 4, { bins: new Array(49).fill(1) }), [
        [0, 0, 1, 4]
    ]);
});

test('present and small bins keep a minimal height scaled to the pixel ratio', () => {
    const options = { bins: [0, 1, 0, 100], presence: new Uint8Array([0, 0, 1, 0]) };

    assert.deepEqual(bars(4, 10, options, 1), [
        [1, 9, 1, 1],
        [2, 9, 1, 1],
        [3, 0, 1, 10]
    ]);
    assert.deepEqual(bars(4, 10, options, 0.5).map(([,, , h]) => h), [1, 1, 10]);
    assert.deepEqual(bars(4, 10, options, 2).map(([,, , h]) => h), [2, 2, 10]);
    assert.deepEqual(bars(4, 10, options, 3).map(([,, , h]) => h), [2, 2, 10]);
    assert.deepEqual(bars(4, 10, options, 4).map(([,, , h]) => h), [3, 3, 10]);

    // Presence of any bin sharing a pixel keeps the pixel visible
    assert.deepEqual(bars(1, 10, { bins: [0, 0], presence: [0, 1] }), [[0, 9, 1, 1]]);
});

test('heights follow the scale and an explicit maximum', () => {
    const bins = [0, 3, 15, 63];

    assert.deepEqual(bars(4, 12, { bins, max: 126 }).map(([,, , h]) => h), [1, 1, 6]);
    assert.deepEqual(bars(4, 12, { bins, scale: 'linear' }).map(([,, , h]) => h), [1, 3, 12]);
    assert.deepEqual(bars(4, 12, { bins, scale: 'log' }).map(([,, , h]) => h), [4, 8, 12]);
    assert.deepEqual(bars(4, 12, { bins, scale: 'sqrt' }).map(([,, , h]) => h), [3, 6, 12]);
});

test('bins without a positive maximum draw only their presence', () => {
    for (const scale of ['linear', 'log', 'sqrt']) {
        assert.deepEqual(bars(3, 4, { bins: [0, 0, 0], presence: [0, 1, 0], scale }), [[1, 3, 1, 1]]);
        assert.deepEqual(bars(3, 4, { bins: [], scale }), []);
    }
});

test('bins far below a shared maximum show their own shape behind', () => {
    const presence = [1, 0, 0, 0];
    const [relative, shared] = draw(4, 10, { bins: [0, 2, 4, 8], presence, max: 20, binsMax: true });

    assert.deepEqual(relative, { color: '#abc', alpha: 0.4, rects: [
        [1, 7, 1, 3],
        [2, 5, 1, 5],
        [3, 0, 1, 10]
    ] });
    assert.deepEqual(shared, { color: '#abc', alpha: 1, rects: [
        [0, 9, 1, 1],
        [1, 9, 1, 1],
        [2, 8, 1, 2],
        [3, 6, 1, 4]
    ] });

    // Close to the shared maximum, without it or when not requested only the shared bars remain
    assert.equal(draw(4, 10, { bins: [0, 2, 4, 9], max: 10, binsMax: true }).length, 1);
    assert.equal(draw(4, 10, { bins: [0, 2, 4, 8.99], max: 10, binsMax: true }).length, 2);
    assert.equal(draw(4, 10, { bins: [0, 2, 4, 8], binsMax: true }).length, 1);
    assert.equal(draw(4, 10, { bins: [0, 2, 4, 8], max: 20 }).length, 1);
});

function renderHistogram(config, data, { dpr = 2, color = '' } = {}) {
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
            drawn.push({ canvas: ctx.canvas, options, color, dpr, width: ctx.canvas.width, height: ctx.canvas.height });
        },
        discovery: { view: { define: (_, callback) => render = callback } },
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
        getComputedStyle: element => ({
            getPropertyValue: name => element === el && name === '--color' ? color || el.style.get('--color') || '' : ''
        }),
        HTMLElement: class {},
        customElements: { define: (name, Element) => lifecycle = { name, Element } }
    });

    render(el, config, data);

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
        connect: () => lifecycleElement.connectedCallback(),
        disconnect: () => lifecycleElement.disconnectedCallback(),
        resize: width => resize([{ contentRect: { width } }])
    };
}

test('draws on a canvas sized to its CSS box and pixel ratio while connected', () => {
    const bins = [1, 2, 3];
    const presence = [0, 1, 0];
    const histogram = renderHistogram({ bins, presence, max: 5, binsMax: true, scale: 'log', height: 30 }, null, { dpr: 1.5 });

    assert.equal(histogram.canvas.tagName, 'canvas');
    assert.equal(histogram.canvas.style.height, '30px');
    assert.deepEqual(histogram.observed, []);

    histogram.connect();
    assert.deepEqual(histogram.observed, [histogram.canvas]);
    assert.deepEqual(histogram.drawn, []);

    histogram.resize(100.4);
    histogram.resize(201);
    assert.deepEqual(histogram.drawn.map(({ canvas, width, height, dpr }) => [canvas, width, height, dpr]), [
        [histogram.canvas, 151, 45, 1.5],
        [histogram.canvas, 302, 45, 1.5]
    ]);
    assert.deepEqual({ ...histogram.drawn[0].options }, { bins, presence, max: 5, binsMax: true, scale: 'log' });
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
