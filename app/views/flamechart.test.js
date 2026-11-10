import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { FlameChart } from './flamechart/index.js';
import Tooltip from './flamechart/tooltip.js';
import { CallTree } from '../prepare/computations/call-tree.js';

afterEach(() => vi.unstubAllGlobals());

function createChart(width = 1000, height = 170, dpr = 1, reducedMotion = true) {
    const scheduled = new Map();
    const elements = [];
    const motion = new EventTarget();
    let time = 0;
    let timer = 0;
    let resize;

    class Element extends EventTarget {
        style = {};
        children = [];
        scrollTop = 0;
        clientHeight = height;
        width = 0;
        height = 0;
        context = {
            fillRect: vi.fn(),
            clearRect: vi.fn(),
            strokeRect: vi.fn(),
            fillText: vi.fn(),
            setTransform: vi.fn(),
            save() {},
            restore() {},
            beginPath() {},
            rect() {},
            clip() {},
            measureText: text => ({ width: text.length * 6 })
        };

        append(...children) {
            this.children.push(...children);
        }

        remove() {
            this.removed = true;
        }

        getContext() {
            return this.context;
        }

        getBoundingClientRect() {
            return { width, height, left: 0, top: 0 };
        }
    }

    vi.stubGlobal('document', {
        fonts: new EventTarget(),
        createElement: tag => {
            const element = new Element();

            element.tagName = tag;
            elements.push(element);

            return element;
        }
    });
    motion.matches = reducedMotion;

    vi.stubGlobal('window', {
        devicePixelRatio: dpr,
        matchMedia: () => motion
    });
    vi.stubGlobal('performance', { now: () => time });
    // Custom properties are read from the element's own style, so the theme fallback applies by default.
    vi.stubGlobal('getComputedStyle', element => ({
        color: '#ccc',
        getPropertyValue: name => element.style[name] || ''
    }));
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback) {
            resize = callback;
        }

        observe() {}
        disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', callback => {
        scheduled.set(++timer, callback);

        return timer;
    });
    vi.stubGlobal('cancelAnimationFrame', id => scheduled.delete(id));

    const scroll = new Element();
    const chart = new FlameChart(scroll);
    const canvas = elements.find(element => element.tagName === 'canvas');
    const flush = (elapsed = 1000 / 60) => {
        const callbacks = [...scheduled.values()];

        time += elapsed;
        scheduled.clear();

        for (let i = 0; i < callbacks.length; i++) {
            callbacks[i](time);
        }
    };

    return {
        chart,
        canvas,
        scroll,
        elements,
        scheduled,
        motion,
        flush,
        // The bound turns an animation that never converges into a failure instead of a hang.
        settle(onFrame) {
            let frames = 0;

            while (scheduled.size > 0 && frames < 200) {
                flush();
                frames++;
                onFrame?.();
            }

            assert.equal(scheduled.size, 0, 'Animation settles');

            return frames;
        },
        recordFills() {
            const fills = [];

            canvas.context.fillRect.mockImplementation((left, top, width, height) => {
                fills.push({
                    left,
                    top,
                    width,
                    height,
                    alpha: canvas.context.globalAlpha,
                    color: canvas.context.fillStyle
                });
            });

            return fills;
        },
        load(tree, values, options = {}) {
            chart.setData(tree, { ...options, value: index => values[index] });
        },
        pointer(type, x, y, metaKey = false) {
            const event = new Event(type);

            Object.assign(event, { clientX: x, clientY: y, metaKey });
            canvas.dispatchEvent(event);
        },
        scrollTo(top) {
            scroll.scrollTop = top;
            scroll.dispatchEvent(new Event('scroll'));
        },
        resize(nextWidth = width) {
            width = nextWidth;
            resize();
        }
    };
}

// root (100) has A (40) → B (20) and C (60) → B (30); both B nodes share one dictionary entry.
function fixture() {
    const tree = new CallTree(
        [{ name: 'root' }, { name: 'A' }, { name: 'B' }, { name: 'C' }],
        new Uint32Array([0, 1, 2, 3, 2]),
        new Uint32Array([0, 0, 1, 0, 3]),
        new Uint32Array([4, 1, 0, 1, 0])
    );
    const values = [100, 40, 20, 60, 30];

    return { tree, values };
}

// Every node has its own dictionary entry, named and indexed by the node.
function frameTree(parent, subtreeSize) {
    const nodes = Uint32Array.from(parent, (_, index) => index);

    return new CallTree(
        Array.from(nodes, index => ({ name: `Frame ${index}`, index })),
        nodes,
        Uint32Array.from(parent),
        Uint32Array.from(subtreeSize)
    );
}

// root (100) has a chain of 40-wide frames at depths 1..count-2 and a 60-wide leaf sibling (count-1) at depth 1.
function deepChain(count) {
    const parent = Array.from({ length: count }, (_, index) => Math.max(0, index - 1));
    const subtreeSize = Array.from({ length: count }, (_, index) => Math.max(0, count - index - 2));
    const values = new Array(count).fill(40);

    parent[count - 1] = 0;
    subtreeSize[0] = count - 1;
    values[0] = 100;
    values[count - 1] = 60;

    return { tree: frameTree(parent, subtreeSize), values };
}

// With this mapper the red channel of a fill color is the frameTree node index.
const indexColor = entry => `${entry.index}, 0, 0`;
const fillNode = fill => Number(/rgb\((\d+),/.exec(fill.color)[1]);

// Each painted rectangle is picked at its center; a child lies within its parent, painted earlier in the same frame.
function assertInsideParents(chart, tree, rects) {
    const painted = new Map();

    for (let i = 0; i < rects.length; i++) {
        const [left, top, width] = rects[i];
        const node = chart.findFrameAt(left + width / 2, top + 5);

        assert.notEqual(node, -1);
        painted.set(node, { left, right: left + width });

        if (node !== 0) {
            const parent = painted.get(tree.parent[node]);

            assert.ok(parent, `Node ${node} is painted without its parent`);
            assert.ok(left >= parent.left - 1e-9, `Node ${node} starts before its parent`);
            assert.ok(left + width <= parent.right + 1e-9, `Node ${node} ends after its parent`);
        }
    }
}

test('setData options select names, metrics and sibling order, keeping defaults for non-callable options', () => {
    const { chart, flush } = createChart();
    const tree = new CallTree(
        [{ name: 'root' }, { name: 'Zulu' }, { name: 'Alpha' }, { name: 'Middle' }],
        new Uint32Array([0, 2, 1, 2, 3, 1]),
        new Uint32Array(6),
        new Uint32Array([5, 0, 0, 0, 0, 0])
    );
    const values = [150, 10, 20, 30, 40, 50];
    const renamed = { Zulu: 'First', Alpha: 'Last' };
    const rename = entry => renamed[entry.name] || entry.name;
    const requested = [];
    const value = index => {
        requested.push(index);

        return values[index];
    };
    const cases = [
        {
            options: { name: {}, value, childrenSort: 'invalid' },
            order: [1, 2, 3, 4, 5]
        },
        {
            options: { value, childrenSort: 'name' },
            order: [1, 3, 4, 2, 5]
        },
        {
            options: { name: rename, value, childrenSort: 'name' },
            order: [2, 5, 1, 3, 4]
        },
        {
            options: { value, childrenSort: (left, right) => right - left },
            order: [5, 4, 3, 2, 1]
        }
    ];

    try {
        for (const options of [undefined, null, { name: 'name', value: 42 }]) {
            chart.setData(tree, options);
            flush();

            assert.deepEqual(chart.nodesNames, ['root', 'Zulu', 'Alpha', 'Middle']);
        }

        for (const row of cases) {
            requested.length = 0;
            chart.setData(tree, row.options);
            flush();

            assert.deepEqual([...new Set(requested)].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5]);
            assert.deepEqual(Array.from(chart.children.subarray(0, chart.childrenOffset[0])), row.order);

            let position = 0;

            for (let i = 0; i < row.order.length; i++) {
                const node = row.order[i];

                assert.equal(chart.nodesX[node], position);
                assert.equal(chart.findFrameAt((position + values[node] / 2) / 150 * 1000, 22), node);
                position += values[node];
            }
        }
    } finally {
        chart.destroy();
    }
});

test.each([
    {
        range: 'the whole tree',
        args: [],
        frames: [[0, 0, 0, 1], [1, 1, 0.6, 1], [2, 2, 0.6, 0.8], [3, 1, 0, 0.6], [4, 2, 0, 0.3]]
    },
    {
        range: 'a half-open range',
        args: [0.3, 0.6],
        frames: [[0, 0, 0, 1], [3, 1, 0, 0.6]]
    },
    {
        range: 'a minimum scale',
        args: [0, 1, 0.3],
        frames: [[0, 0, 0, 1], [1, 1, 0.6, 1], [3, 1, 0, 0.6], [4, 2, 0, 0.3]]
    }
])('getVisibleFrames lazily sorts and filters frames by $range', row => {
    const { chart, load } = createChart();
    const { tree, values } = fixture();

    load(tree, values, { childrenSort: true });

    const visible = chart.getVisibleFrames(...row.args);

    assert.deepEqual(visible.map(frame => [frame.nodeIndex, frame.depth, frame.x0, frame.x1]), row.frames);
    assert.equal(visible[0].value, tree.dictionary[0]);
    assert.equal(visible[1].name, tree.dictionary[tree.nodes[row.frames[1][0]]].name);

    chart.destroy();
});

test.each([
    {
        state: 'before data is set',
        prepare() {}
    },
    {
        state: 'after destruction',
        prepare(harness) {
            const { tree, values } = fixture();

            harness.load(tree, values);
            harness.flush();
            harness.chart.destroy();
            harness.chart.destroy();
            harness.load(tree, values);
        }
    }
])('public operations are inert $state', row => {
    const harness = createChart();
    const { chart, canvas, flush, scheduled } = harness;
    const events = [];

    for (const name of ['select', 'zoom', 'render', 'destroy']) {
        chart.on(name, () => events.push(name));
    }

    row.prepare(harness);
    events.length = 0;
    scheduled.clear();
    canvas.context.fillRect.mockClear();

    chart.render();
    chart.zoomFrame(1);
    chart.resetZoom();

    assert.equal(chart.selectFrame(1), -1);
    assert.deepEqual(chart.getVisibleFrames(), []);
    assert.equal(chart.findFrameAt(100, 5), -1);

    flush();

    assert.deepEqual(events, []);
    assert.equal(canvas.context.fillRect.mock.calls.length, 0);
});

test.each([
    { node: -1 },
    { node: 5 }
])('selection and zoom ignore node $node outside the tree', row => {
    const { chart, flush, load } = createChart();
    const { tree, values } = fixture();
    const events = [];

    load(tree, values, { childrenSort: true });
    flush();
    chart.selectFrame(2);
    chart.zoomFrame(1);
    chart.on('select', (...args) => events.push(['select', ...args]));
    chart.on('zoom', (...args) => events.push(['zoom', ...args]));

    assert.equal(chart.selectFrame(row.node), 2);
    chart.zoomFrame(row.node);

    assert.deepEqual(events, []);
    assert.equal(chart.selectedNode, 2);
    assert.equal(chart.zoomedNode, 1);

    chart.destroy();
});

// Node 4 shares the dictionary entry of node 2; the root is never selected
test.each([
    {
        target: 'B with nothing selected',
        selected: -1,
        node: 2,
        expected: 2
    },
    {
        target: 'A with B selected',
        selected: 2,
        node: 1,
        expected: 1
    },
    {
        target: 'the other B with B selected',
        selected: 2,
        node: 4,
        expected: -1
    },
    {
        target: 'the root with B selected',
        selected: 2,
        node: 0,
        expected: -1
    },
    {
        target: 'the root with nothing selected',
        selected: -1,
        node: 0,
        expected: -1
    }
])('selecting $target reports the resulting selection', row => {
    const { chart, flush, load } = createChart();
    const { tree, values } = fixture();
    const events = [];

    load(tree, values);
    flush();
    chart.selectFrame(row.selected);
    chart.on('select', (...args) => events.push(args));

    assert.equal(chart.selectFrame(row.node), row.expected);
    assert.equal(chart.selectedNode, row.expected);
    assert.deepEqual(events, [[row.expected, row.selected]]);

    chart.destroy();
});

// With children sorted by value, C spans [0, 0.6] and A spans [0.6, 1]
test.each([
    {
        action: 'into the root from the root',
        zoomed: 0,
        node: 0,
        toggle: false,
        events: []
    },
    {
        action: 'into A from the root',
        zoomed: 0,
        node: 1,
        toggle: false,
        events: [[1, 0.6, 1]]
    },
    {
        action: 'into A again',
        zoomed: 1,
        node: 1,
        toggle: false,
        events: []
    },
    {
        action: 'into A again as a toggle',
        zoomed: 1,
        node: 1,
        toggle: true,
        events: [[0, 0, 1]]
    },
    {
        action: 'into the root from A',
        zoomed: 1,
        node: 0,
        toggle: false,
        events: [[0, 0, 1]]
    },
    {
        action: 'into C from A',
        zoomed: 1,
        node: 3,
        toggle: false,
        events: [[3, 0, 0.6]]
    }
])('zooming $action reports the resulting zoom', row => {
    const { chart, flush, load } = createChart();
    const { tree, values } = fixture();
    const events = [];

    load(tree, values, { childrenSort: true });
    flush();
    chart.zoomFrame(row.zoomed);
    chart.on('zoom', (...args) => events.push(args));

    chart.zoomFrame(row.node, row.toggle);

    assert.deepEqual(events, row.events);

    chart.destroy();
});

test.each([
    {
        from: 'the root',
        values: [100, 40, 20, 60, 30],
        zoom: [],
        events: []
    },
    {
        from: 'A',
        values: [100, 40, 20, 60, 30],
        zoom: [1],
        events: [[0, 0, 1]]
    },
    // Zooming into B under C without width falls back to the root with A in the zoom history
    {
        from: 'a fallback to the root',
        values: [100, 40, 20, 60, 0],
        zoom: [1, 4],
        events: []
    }
])('resetZoom from $from reports the resulting zoom', row => {
    const { chart, flush, load } = createChart();
    const { tree } = fixture();
    const events = [];

    load(tree, row.values, { childrenSort: true });
    flush();

    for (let i = 0; i < row.zoom.length; i++) {
        chart.zoomFrame(row.zoom[i]);
    }

    chart.on('zoom', (...args) => events.push(args));
    chart.resetZoom();

    assert.deepEqual(events, row.events);
    assert.equal(chart.zoomedNode, 0);

    chart.destroy();
});

test.each([
    {
        target: 'a node of the same range',
        // B covers all of A
        values: [100, 40, 40, 60, 30],
        node: 2,
        events: [[2, 0.6, 1]]
    },
    {
        target: 'a frame without width',
        values: [100, 40, 20, 60, 0],
        node: 4,
        events: [[0, 0, 1]]
    }
])('zooming from A into $target reports the resulting zoom', row => {
    const { chart, flush, load } = createChart();
    const { tree } = fixture();
    const events = [];

    load(tree, row.values, { childrenSort: true });
    flush();
    chart.zoomFrame(1);
    chart.on('zoom', (...args) => events.push(args));

    chart.zoomFrame(row.node);

    assert.deepEqual(events, row.events);

    chart.destroy();
});

test.each([
    {
        change: 'keeps the zoomed range',
        before: [100, 40, 20, 60, 30],
        zoomed: 1,
        after: [100, 40, 20, 60, 30],
        events: []
    },
    {
        // B covers all of A, so both move to [0.5, 1]
        change: 'moves the zoomed range start',
        before: [100, 40, 40, 60, 30],
        zoomed: 2,
        after: [100, 50, 50, 50, 30],
        events: [[2, 0.5, 1]]
    },
    {
        change: 'removes the zoomed frame width',
        before: [100, 40, 20, 60, 30],
        zoomed: 1,
        after: [100, 0, 0, 60, 30],
        events: [[0, 0, 1]]
    }
])('a metric update that $change reports the resulting zoom', row => {
    const { chart, flush, load } = createChart();
    const { tree } = fixture();
    const values = row.before.slice();
    const events = [];

    load(tree, values, { childrenSort: true });
    flush();
    chart.zoomFrame(row.zoomed);
    chart.on('zoom', (...args) => events.push(args));

    values.splice(0, values.length, ...row.after);
    chart.resetValues();
    flush();

    assert.deepEqual(events, row.events);

    chart.destroy();
});

test.each([
    {
        change: 'a metric update',
        update(chart) {
            chart.resetValues();
        }
    },
    {
        change: 'new data',
        update(chart, tree, values) {
            chart.setData(tree, { value: index => values[index] });
        }
    }
])('$change ends the hover over a frame', row => {
    const { chart, flush, load, pointer } = createChart();
    const { tree, values } = fixture();
    const events = [];

    load(tree, values);
    flush();
    chart.on('frame:enter', node => events.push(['enter', node]));
    chart.on('frame:leave', () => events.push(['leave']));
    pointer('pointermove', 100, 22);

    row.update(chart, tree, values);

    assert.deepEqual(events, [['enter', 1], ['leave']]);

    chart.destroy();
});

test('zoom history returns only to frames shallower than the current zoom', () => {
    const cases = [
        { path: [1, 3], back: [0] },
        { path: [1, 2, 3], back: [0] },
        { path: [3, 4], back: [3, 0] }
    ];

    for (const row of cases) {
        const { chart, flush, load } = createChart();
        const { tree, values } = fixture();
        const visited = [];

        load(tree, values);
        flush();

        for (let i = 0; i < row.path.length; i++) {
            chart.zoomFrame(row.path[i]);
        }

        for (let i = 0; i < row.path.length && chart.zoomedNode !== 0; i++) {
            chart.zoomFrame(chart.zoomedNode, true);
            visited.push(chart.zoomedNode);
        }

        assert.deepEqual(visited, row.back, `Zoom path ${row.path}`);
        chart.destroy();
    }
});

test('frame colors mix with the theme background and keep hover, selection and zoom priorities', () => {
    const { chart, canvas, pointer, flush, load, recordFills } = createChart();
    const { tree, values } = fixture();
    const fills = recordFills();
    const labels = [];
    const firstChild = () => fills.find(fill => fill.left === 0 && fill.top === 17);

    chart.colorMapper = () => '200, 120, 80';
    canvas.context.fillText.mockImplementation(text => {
        labels.push({ text, color: canvas.context.fillStyle });
    });
    load(tree, values);
    flush();

    try {
        assert.equal(firstChild().color, 'color-mix(in srgb, rgb(200, 120, 80) 40%, #242424)');
        assert.ok(labels.length > 0);

        for (let i = 0; i < labels.length; i++) {
            assert.equal(labels[i].color, '#ccc');
        }

        chart.el.style['--discovery-background-color'] = ' #101010 ';
        fills.length = 0;
        pointer('pointermove', 100, 22);
        flush();
        assert.equal(firstChild().color, 'color-mix(in srgb, rgb(200, 120, 80) 30%, #101010)');

        fills.length = 0;
        pointer('pointerleave', 0, 0);
        flush();
        assert.equal(firstChild().color, 'color-mix(in srgb, rgb(200, 120, 80) 40%, #101010)');

        // Both B nodes share a dictionary entry, so selecting one highlights both, over hover.
        fills.length = 0;
        labels.length = 0;
        chart.selectFrame(2);
        pointer('pointermove', 500, 40);
        flush();
        assert.deepEqual(fills.filter(fill => fill.top === 34).map(fill => fill.color), ['#d6bb2d', '#d6bb2d']);
        assert.deepEqual(labels.filter(label => label.text === 'B').map(label => label.color), ['#000', '#000']);
        assert.equal(canvas.context.strokeRect.mock.calls.length, 0);

        fills.length = 0;
        chart.zoomFrame(1);
        flush();
        assert.equal(fills.find(fill => fill.top === 0).alpha, 0.65);
        assert.equal(chart.el.children[1].style.opacity, '0.65');
        assert.deepEqual(canvas.context.strokeRect.mock.calls, [[0.75, 17.75, 997.5, 14.5]]);
        assert.equal(canvas.context.strokeStyle, '#d6bb2d');
        assert.equal(canvas.context.lineWidth, 1.5);

        canvas.context.strokeRect.mockClear();
        chart.resetZoom();
        flush();
        assert.equal(chart.el.children[1].style.opacity, '1');
        assert.equal(canvas.context.strokeRect.mock.calls.length, 0);
    } finally {
        chart.destroy();
    }
});

test('root content is rendered once into the root label with the root frame and value', () => {
    const { chart, flush, load } = createChart();
    const { tree, values } = fixture();
    const renderRoot = vi.fn();

    chart.on('render', renderRoot);
    load(tree, values);
    flush();
    chart.scheduleRender();
    flush();

    const [[element, frame, value]] = renderRoot.mock.calls;

    assert.equal(renderRoot.mock.calls.length, 1);
    assert.equal(element, chart.el.children[1]);
    assert.equal(frame.value, tree.dictionary[0]);
    assert.equal(frame.color, '158,204,109');
    assert.equal(value, 100);

    chart.destroy();
});

const blueMapper = (entry, hue) => hue === 'blue' ? '10, 20, 30' : '40, 50, 60';

// Each row expects the root frame's name, color, x0 and x1, and the root value
test.each([
    {
        change: 'a zoom, not each frame of its motion',
        update(harness) {
            harness.chart.zoomFrame(1);
            harness.flush(20);
            harness.flush(20);
        },
        root: ['root', '158,204,109', 0, 1, 100]
    },
    {
        change: 'a color hue',
        update(harness) {
            harness.chart.colorHue = 'blue';
        },
        root: ['root', '131,180,229', 0, 1, 100]
    },
    {
        change: 'a color mapper',
        update(harness) {
            harness.chart.colorMapper = blueMapper;
        },
        root: ['root', '40, 50, 60', 0, 1, 100]
    },
    {
        change: 'a color mapper with the current hue',
        update(harness) {
            harness.chart.colorHue = 'blue';
            harness.chart.colorMapper = blueMapper;
        },
        root: ['root', '10, 20, 30', 0, 1, 100]
    },
    {
        change: 'a color hue with the current mapper',
        update(harness) {
            harness.chart.colorMapper = blueMapper;
            harness.chart.colorHue = 'blue';
        },
        root: ['root', '10, 20, 30', 0, 1, 100]
    },
    {
        change: 'a metric update',
        update(harness, values) {
            values[1] = 70;
            values[3] = 50;
            harness.chart.resetValues();
        },
        root: ['root', '158,204,109', 0, 1, 120]
    },
    {
        change: 'new names',
        update(harness, values, tree) {
            harness.chart.setData(tree, {
                name: entry => `Updated ${entry.name}`,
                value: index => values[index]
            });
        },
        root: ['Updated root', '158,204,109', 0, 1, 100]
    },
    {
        // Without metrics the root frame still spans the whole chart
        change: 'zero metrics',
        update(harness, values) {
            values.fill(0);
            harness.chart.resetValues();
        },
        root: ['root', '158,204,109', 0, 1, 0]
    }
])('root content is refreshed once by $change', row => {
    const harness = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const renderRoot = vi.fn();

    harness.chart.on('render', renderRoot);
    harness.load(tree, values);
    harness.flush(0);
    renderRoot.mockClear();

    row.update(harness, values, tree);
    harness.flush(20);

    const [[, frame, value]] = renderRoot.mock.calls;

    assert.equal(renderRoot.mock.calls.length, 1);
    assert.deepEqual([frame.name, frame.color, frame.x0, frame.x1, value], row.root);

    harness.chart.destroy();
});

test.each([
    {
        change: 'a selection',
        update(harness) {
            harness.chart.selectFrame(2);
        }
    },
    {
        change: 'a hover',
        update(harness) {
            harness.pointer('pointermove', 100, 20);
        }
    },
    {
        change: 'a resize',
        update(harness) {
            harness.resize(800);
        }
    }
])('root content is not refreshed by $change', row => {
    const harness = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const renderRoot = vi.fn();

    harness.chart.on('render', renderRoot);
    harness.load(tree, values);
    harness.flush(0);
    renderRoot.mockClear();

    row.update(harness);
    harness.flush(20);

    assert.equal(renderRoot.mock.calls.length, 0);

    harness.chart.destroy();
});

test('frame clicks notify observers before the default selection or zoom toggle', () => {
    const { chart, canvas, pointer, flush, load } = createChart();
    const { tree, values } = fixture();
    const events = [];

    load(tree, values, { childrenSort: true });
    flush();
    chart.on('frame:click', (node, element, event) => {
        assert.equal(element, canvas);
        assert.equal(event.type, 'click');
        events.push(['click', node, chart.selectedNode, chart.zoomedNode]);
    });
    chart.on('select', node => events.push(['select', node]));
    chart.on('zoom', node => events.push(['zoom', node]));

    try {
        pointer('click', 650, 40, true);
        flush();
        assert.deepEqual(events.splice(0), [['click', 2, -1, 0], ['select', 2]]);

        // Node 4 shares node 2's dictionary entry, so it toggles the same selection off.
        pointer('click', 100, 40, true);
        assert.deepEqual(events.splice(0), [['click', 4, 2, 0], ['select', -1]]);

        pointer('click', 650, 20);
        flush();
        assert.deepEqual(events.splice(0), [['click', 1, -1, 0], ['zoom', 1]]);
        assert.equal(chart.zoomStart, 0.6);
        assert.equal(chart.zoomEnd, 1);
        assert.equal(chart.findFrameAt(100, 40), 2);

        pointer('click', 100, 40);
        flush();
        pointer('click', 100, 40);
        flush();
        assert.deepEqual(events.splice(0), [['click', 2, -1, 1], ['zoom', 2], ['click', 2, -1, 2], ['zoom', 1]]);

        chart.emit('frame:click', 1, canvas, new Event('click'));
        assert.deepEqual(events.splice(0), [['click', 1, -1, 1], ['zoom', 0]]);
    } finally {
        chart.destroy();
    }
});

test('frame separators belong to the preceding frame without swallowing empty space', () => {
    for (const dpr of [1, 1.5, 2]) {
        const { chart, pointer, flush, load, scrollTo } = createChart(1000, 100, dpr);
        const { tree, values } = fixture();
        const enter = vi.fn();
        const leave = vi.fn();

        load(tree, values, { childrenSort: true });
        flush();
        chart.on('frame:enter', enter).on('frame:leave', leave);

        pointer('pointermove', 598, 22);
        pointer('pointermove', 599.5, 22);
        pointer('pointermove', 599.5, 33.5);

        assert.equal(enter.mock.calls.length, 1);
        assert.equal(enter.mock.calls[0][0], 3);
        assert.equal(leave.mock.calls.length, 0);
        assert.equal(chart.findFrameAt(599.5, 33.5), 3);
        assert.equal(chart.findFrameAt(600, 22), 1);
        assert.equal(chart.findFrameAt(100, 34), 4);
        assert.equal(chart.findFrameAt(299.5, 39), 4);
        assert.equal(chart.findFrameAt(300, 39), -1);
        assert.equal(chart.findFrameAt(500, 39), -1);

        pointer('click', 599.5, 22, true);
        assert.equal(chart.selectedNode, 3);
        pointer('pointermove', 600, 22);
        assert.equal(enter.mock.calls.at(-1)[0], 1);
        assert.equal(leave.mock.calls.length, 0);
        pointer('pointermove', 500, 39);
        assert.equal(leave.mock.calls.length, 1);

        scrollTo(17.25);
        flush();

        assert.equal(chart.findFrameAt(599.5, 16.5), 3);
        assert.equal(chart.findFrameAt(100, 16.75), 4);
        chart.destroy();
    }
});

test.each([
    {
        state: 'settled',
        prepare(harness) {
            harness.scrollTo(5 * 17);
            harness.flush();
            harness.scrollTo(5);
            harness.flush();
        },
        // Scrolled by 5px: y = 12 is the first pixel of depth 1, y = 80 lies below the 51px canvas.
        points: [[0, 0, 0], [0, 12, 1], [999.5, 12, 21], [1000, 12, -1], [100, -0.5, -1], [100, 80, -1]]
    },
    {
        state: 'animating',
        prepare(harness) {
            harness.chart.zoomFrame(1);
            harness.flush(20);
        },
        points: [[0, 0, 0], [0, 17, 1], [1000, 17, -1], [100, -0.5, -1], [100, 80, -1]]
    }
])('findFrameAt treats the canvas as a half-open area ($state)', row => {
    const harness = createChart(1000, 51, 1, false);
    const { chart, flush, load } = harness;
    const { tree, values } = deepChain(22);

    load(tree, values);
    flush(0);
    row.prepare(harness);

    for (let i = 0; i < row.points.length; i++) {
        const [x, y, node] = row.points[i];

        assert.equal(chart.findFrameAt(x, y), node, `Point ${x}, ${y}`);
    }

    chart.destroy();
});

test('picked zoom moves common frames promptly while departing fills fade in place and keep their hit area', () => {
    const { chart, flush, load, recordFills } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    load(tree, values);
    flush(0);

    const fills = recordFills();

    chart.zoomFrame(1);
    flush(65);

    const retained = fills.find(fill => fill.left === 0 && fill.top === 17);
    const departing = fills.find(fill => fill.left === 400 && fill.top === 17);
    const right = retained.left + retained.width;

    // After one time constant the common frame has covered 1 - 1/e of its 600px growth.
    assert.ok(Math.abs(retained.width - (399 + 600 * (1 - Math.exp(-1)))) < 1e-9);
    assert.equal(departing.width, 599);
    assert.ok(departing.alpha > 0 && departing.alpha < 0.05);
    assert.equal(chart.findFrameAt(right - 0.25, 22), 1);
    assert.equal(chart.findFrameAt(right + 0.25, 22), 3, 'Visible departing fill wins over the common frame border');
    assert.equal(chart.findFrameAt(right + 0.25, 33.5), 3);

    fills.length = 0;
    flush(15);

    const next = fills.find(fill => fill.left === 0 && fill.top === 17);
    const nextRight = next.left + next.width;

    assert.equal(
        chart.findFrameAt(nextRight + 0.25, 22),
        1,
        'An unpickable faded frame does not block border ownership'
    );
    assert.equal(chart.findFrameAt(nextRight + 1, 22), -1);
    chart.destroy();
});

test('rebinding the same tree preserves selection, zoom history and displayed motion', () => {
    for (const elapsed of [20, 1000]) {
        const { chart, flush, settle, load, recordFills } = createChart(1000, 170, 1, false);
        const { tree, values } = fixture();
        const fills = recordFills();

        load(tree, values, { childrenSort: true });
        flush(0);
        chart.selectFrame(2);
        chart.zoomFrame(1);
        flush(1000);
        chart.zoomFrame(2);
        fills.length = 0;
        flush(elapsed);

        const before = fills.slice();

        values[1] = 70;
        values[2] = 35;
        values[3] = 30;
        chart.setData(tree, {
            name: entry => `Updated ${entry.name}`,
            value: index => values[index],
            childrenSort: true
        });

        try {
            assert.equal(chart.selectedNode, 2);
            assert.equal(chart.zoomedNode, 2);
            assert.deepEqual(chart.zoomedNodesStack, [1]);

            fills.length = 0;
            flush(0);

            assert.deepEqual(fills, before, 'Same-tree updates begin at the displayed frame');
            assert.equal(chart.zoomStart, 0);
            assert.equal(chart.zoomEnd, 0.35);
            assert.equal(chart.nodesNames[2], 'Updated B');

            settle();

            assert.equal(chart.findFrameAt(100, 40), 2);
            chart.zoomFrame(2, true);
            assert.equal(chart.zoomedNode, 1);
            assert.equal(chart.selectedNode, 2);
        } finally {
            chart.destroy();
        }
    }
});

test('tooltip refreshes metrics for the same hovered node after invalidation', () => {
    const { chart, pointer, flush, load } = createChart();
    const { tree, values } = fixture();
    const renderedValues = [];
    const popup = {
        show: vi.fn((anchor, render) => render?.({})),
        hide: vi.fn(),
        destroy: vi.fn()
    };

    class Popup {
        constructor() {
            return popup;
        }
    }

    const tooltip = new Tooltip({ view: { Popup } }, (el, node) => renderedValues.push(values[node]));

    chart.on('frame:enter', tooltip.show);
    chart.on('frame:leave', tooltip.hide);
    chart.on('destroy', tooltip.destroy);
    load(tree, values);
    flush();

    try {
        pointer('pointermove', 100, 20);
        flush();
        assert.deepEqual(renderedValues, [40]);

        tooltip.show(1);
        assert.deepEqual(renderedValues, [40], 'Unchanged content is reused');

        values[1] = 70;
        values[3] = 30;
        tooltip.invalidate();
        chart.resetValues();
        flush();

        assert.deepEqual(renderedValues, [40, 70], 'Stable node identity does not imply stable metrics');
    } finally {
        chart.destroy();
    }

    chart.destroy();
    assert.equal(popup.destroy.mock.calls.length, 1);
});

test('canvas resources are viewport-sized and reused, with cancellable destruction', () => {
    const { chart, canvas, elements, flush, resize, scheduled, load, scrollTo } = createChart(800, 100, 2);
    const { tree, values } = fixture();

    load(tree, values);
    flush();

    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 200);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);

    chart.selectFrame(1);
    flush();
    resize();
    flush();

    assert.equal(elements.length, 3);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);

    scrollTo(17);
    flush();

    assert.equal(chart.findFrameAt(100, 5), 1);

    chart.scheduleRender();
    assert.equal(scheduled.size, 1);

    chart.destroy();
    chart.destroy();
    assert.equal(scheduled.size, 0);

    chart.resetValues();
    assert.equal(scheduled.size, 0);
});

test('a zero-width chart paints nothing and resumes its transition once it has width', () => {
    const { chart, canvas, flush, settle, resize, load } = createChart(0, 170, 1, false);
    const { tree, values } = fixture();
    const renderRoot = vi.fn();

    chart.on('render', renderRoot);
    load(tree, values);
    flush(0);

    assert.equal(canvas.context.fillRect.mock.calls.length, 0);
    assert.equal(renderRoot.mock.calls.length, 0);

    resize(1000);
    flush(0);

    assert.equal(renderRoot.mock.calls.length, 1);
    assert.equal(chart.findFrameAt(100, 22), 1);

    chart.zoomFrame(1);
    flush(20);
    resize(0);
    canvas.context.fillRect.mockClear();
    flush(20);

    assert.equal(canvas.context.fillRect.mock.calls.length, 0);

    resize(1000);
    settle();

    assert.equal(chart.findFrameAt(500, 22), 1);
    assert.equal(chart.findFrameAt(999.5, 22), 1);
    chart.destroy();
});

test('subpixel siblings retain occupied width and reveal original nodes on zoom', () => {
    const { chart, flush, recordFills } = createChart(100, 100);
    const count = 10000;
    const subtreeSize = new Array(count + 1).fill(0);

    subtreeSize[0] = count;

    const tree = frameTree(new Array(count + 1).fill(0), subtreeSize);
    const fills = recordFills();

    chart.setData(tree, {
        value: index => index === 0 ? count : 1,
        childrenSort: true
    });
    flush();

    const row = fills.filter(fill => fill.top === 17);
    let occupied = 0;

    for (let i = 0; i < row.length; i++) {
        occupied += row[i].width;
    }

    assert.equal(occupied, 99);
    assert.equal(row.length, 50);

    const node = chart.findFrameAt(50, 20);

    assert.ok(node > 0);
    chart.zoomFrame(node);
    flush();

    assert.equal(chart.findFrameAt(50, 20), node);
    assert.equal(tree.nodes.length, count + 1);

    chart.destroy();
});

test('LOD keeps self-time gaps, omits zero-value frames and reveals narrow descendants on zoom', () => {
    const { chart, flush, load } = createChart(100);
    const { tree } = fixture();
    const values = [1000, 1, 1, 999, 1];

    load(tree, values, { childrenSort: true });
    flush();

    assert.equal(chart.findFrameAt(50, 20), 3);
    assert.equal(chart.findFrameAt(99.95, 20), -1);
    assert.equal(chart.findFrameAt(50, 40), -1);

    chart.zoomFrame(1);
    flush();
    assert.equal(chart.findFrameAt(50, 40), 2);

    // C's child at 60px gets no marker without a value, although C leaves room for it.
    values.splice(0, values.length, 1000, 600, 1, 400, 0);
    chart.resetZoom();
    chart.resetValues();
    flush();
    assert.equal(chart.findFrameAt(61, 20), 3);
    assert.equal(chart.findFrameAt(61, 40), -1);

    chart.destroy();
});

test('LOD markers do not displace resolvable frames or capture their hit targets', () => {
    // Each case checks the last fill at `depth`, which spans [start, end - 1) and picks `node`.
    const cases = [
        {
            parent: [0, 0, 0],
            subtreeSize: [2, 0, 0],
            values: [1000, 1, 999],
            depth: 1,
            node: 2,
            start: 0.1,
            end: 100,
            picks: []
        },
        {
            parent: [0, 0, 1, 1, 0, 4],
            subtreeSize: [5, 2, 0, 0, 1, 0],
            values: [1000, 500, 499, 1, 500, 500],
            childrenSort: true,
            depth: 2,
            node: 5,
            start: 50,
            end: 100,
            picks: []
        },
        {
            // The marker of node 1 absorbs node 2, which must not end the row.
            parent: [0, 0, 0, 0],
            subtreeSize: [3, 0, 0, 0],
            values: [400, 3, 6, 391],
            depth: 1,
            node: 3,
            start: 2.25,
            end: 100,
            picks: []
        },
        {
            // A marker following a resolvable frame starts at that frame's end.
            parent: [0, 0, 0, 0],
            subtreeSize: [3, 0, 0, 0],
            values: [400, 240, 2, 158],
            depth: 1,
            node: 3,
            start: 60.5,
            end: 100,
            picks: [[60.25, 2]]
        }
    ];

    for (const dpr of [1, 1.5, 2]) {
        for (const row of cases) {
            const { chart, flush, load, recordFills } = createChart(100, 100, dpr);
            const fills = recordFills();
            const tree = frameTree(row.parent, row.subtreeSize);
            const top = row.depth * 17;

            load(tree, row.values, { childrenSort: row.childrenSort });
            flush();

            const rects = fills
                .filter(fill => fill.top === top)
                .map(fill => [fill.left, fill.top, fill.width, fill.height]);

            assert.deepEqual(rects.at(-1), [row.start, top, row.end - row.start - 1, 16]);
            assert.equal(chart.findFrameAt(row.start + 0.01, top + 5), row.node);

            for (let i = 0; i < row.picks.length; i++) {
                const [x, node] = row.picks[i];

                assert.equal(chart.findFrameAt(x, top + 5), node, `dpr ${dpr}, x ${x}`);
            }

            for (let i = 1; i < rects.length; i++) {
                assert.ok(rects[i - 1][0] + rects[i - 1][2] <= rects[i][0]);
            }

            chart.destroy();
        }
    }
});

test('viewport clipping does not move an offscreen frame border into the visible area', () => {
    const { chart, canvas, flush, load } = createChart(100, 100);
    const { tree, values } = fixture();

    load(tree, values);
    flush();
    canvas.context.fillRect.mockClear();

    chart.zoomStart = 0.2;
    chart.zoomEnd = 0.7;
    chart.render();

    assert.deepEqual(canvas.context.fillRect.mock.calls, [
        [0, 0, 100, 16],
        [0, 17, 39, 16],
        [40, 17, 60, 16],
        [40, 34, 59, 16]
    ]);
    assert.equal(chart.findFrameAt(99.75, 5), 0);
    assert.equal(chart.findFrameAt(99.75, 20), 3);
    assert.equal(chart.findFrameAt(99.75, 40), 4);

    chart.destroy();
});

test('projected children stay inside their painted parents, including fractional and clipped edges', () => {
    const cases = [
        {
            values: [1000, 3, 42, 1, 41, 955],
            parent: [0, 0, 0, 2, 2, 0],
            subtreeSize: [5, 0, 2, 0, 0, 0]
        },
        {
            values: [1000, 44, 43, 1, 956],
            parent: [0, 0, 1, 1, 0],
            subtreeSize: [4, 2, 0, 0, 0]
        }
    ];

    for (const row of cases) {
        for (const dpr of [1, 1.5, 2]) {
            const { chart, canvas, flush, load } = createChart(100, 100, dpr);
            const tree = frameTree(row.parent, row.subtreeSize);

            load(tree, row.values);
            flush();

            for (const [start, end] of [[0, 1], [0.0435, 0.9]]) {
                canvas.context.fillRect.mockClear();
                chart.zoomStart = start;
                chart.zoomEnd = end;
                chart.render();

                // Only empty rectangles are exempt; a NaN width is not empty.
                const rects = canvas.context.fillRect.mock.calls.filter(rect => !(rect[2] <= 0));

                assertInsideParents(chart, tree, rects);
            }

            chart.destroy();
        }
    }
});

test('scrolling keeps ancestor clipping without accumulating border offsets at each depth', () => {
    const { chart, canvas, flush, scrollTo } = createChart(100, 17, 1.5);
    const count = 20;
    const tree = frameTree(
        Array.from({ length: count }, (_, index) => Math.max(0, index - 1)),
        Array.from({ length: count }, (_, index) => count - index - 1)
    );

    chart.setData(tree, { value: () => 1000 });
    flush();
    canvas.context.fillRect.mockClear();

    scrollTo(4 * 17 + 0.25);
    flush();

    assert.deepEqual(canvas.context.fillRect.mock.calls, [
        [0, -0.25, 99, 16],
        [0, 16.75, 99, 16]
    ]);
    assert.equal(chart.findFrameAt(50, 5), 4);
    assert.equal(chart.findFrameAt(50, 16.9), 5);
    assert.equal(canvas.height, 26);

    chart.destroy();
});

test('continuous zoom interpolates the displayed viewport by elapsed time and retargets from it', () => {
    const { chart, canvas, flush, settle, scheduled, elements, load } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const renderRoot = vi.fn();
    const boundary = () => canvas.context.fillRect.mock.calls.find(([left, top]) => top === 17 && left > 0)[0];
    // The displayed start approaches A's start 0.6 as 0.6 * (1 - e^(-elapsed / 65)); A's left edge follows it.
    const boundaryAfter = elapsed => {
        const viewStart = 0.6 * (1 - Math.exp(-elapsed / 65));

        return (0.6 - viewStart) / (1 - viewStart) * 1000;
    };

    chart.on('render', renderRoot);
    load(tree, values, { childrenSort: true });
    flush(0);
    canvas.context.fillRect.mockClear();
    chart.zoomFrame(1, false, 'continuous');
    flush(60);

    const first = boundary();

    assert.ok(Math.abs(first - boundaryAfter(60)) < 1e-8);
    assert.equal(chart.zoomStart, 0.6);
    assert.equal(chart.zoomEnd, 1);
    assert.equal(chart.findFrameAt(first / 2, 22), 3);
    assert.equal(chart.findFrameAt((first + 1000) / 2, 22), 1);
    assert.equal(scheduled.size, 1);

    // Repeating the target continues the motion: two 60 ms frames equal one 120 ms step.
    canvas.context.fillRect.mockClear();
    chart.zoomFrame(1, false, 'continuous');
    flush(60);

    const before = canvas.context.fillRect.mock.calls.map(rect => rect.slice());

    assert.ok(Math.abs(boundary() - boundaryAfter(120)) < 1e-8);

    chart.resetZoom();
    canvas.context.fillRect.mockClear();
    flush(0);

    assert.deepEqual(canvas.context.fillRect.mock.calls, before);
    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 1);

    const frames = settle(() => {
        assertInsideParents(chart, tree, canvas.context.fillRect.mock.calls);
        canvas.context.fillRect.mockClear();
    });

    assert.ok(frames > 1);
    assert.equal(chart.findFrameAt(599, 22), 3);
    assert.equal(chart.findFrameAt(600, 22), 1);
    assert.equal(elements.length, 3);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);
    assert.equal(renderRoot.mock.calls.length, 3);

    // C shares its start with the displayed viewport; only the end moves.
    chart.zoomFrame(3, false, 'continuous');
    flush();

    assert.equal(scheduled.size, 1);
    assert.equal(chart.findFrameAt(999.5, 22), 1);

    settle();
    assert.equal(chart.findFrameAt(999.5, 22), 3);

    chart.resetZoom();
    flush();
    assert.equal(scheduled.size, 1);

    chart.destroy();
    assert.equal(scheduled.size, 0);
});

test('reduced motion, metric updates and tree replacement leave no obsolete zoom state or motion', () => {
    const { chart, canvas, flush, settle, motion, scheduled, load } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    load(tree, values, { childrenSort: true });
    flush(0);
    chart.zoomFrame(1);
    flush(20);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    flush();

    assert.equal(chart.findFrameAt(100, 22), 1);
    assert.equal(scheduled.size, 0);

    motion.matches = false;
    motion.dispatchEvent(new Event('change'));
    chart.zoomFrame(2);
    settle();

    values[1] = 70;
    values[2] = 35;
    values[3] = 30;
    chart.resetValues();
    flush();

    assert.equal(chart.zoomedNode, 2);
    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 0.35);

    chart.selectFrame(2);
    values.fill(0);
    chart.resetValues();
    flush();

    assert.equal(chart.zoomedNode, 0);
    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 1);

    settle();
    assert.equal(chart.findFrameAt(100, 22), -1);

    const replacement = fixture();

    load(replacement.tree, replacement.values);
    flush();

    assert.equal(chart.selectedNode, -1);
    assert.equal(chart.getVisibleFrames()[1].value, replacement.tree.dictionary[1]);
    assert.equal(chart.findFrameAt(100, 22), 1);
    assert.equal(chart.findFrameAt(450, 22), 3);
    assert.equal(chart.zoomedNode, 0);
    assert.equal(scheduled.size, 0);

    chart.zoomFrame(1);
    flush(20);
    canvas.context.fillRect.mockClear();
    chart.destroy();
    flush();

    assert.equal(scheduled.size, 0);
    assert.equal(canvas.context.fillRect.mock.calls.length, 0);
});

test('zoom animation dims actual ancestors, not earlier sibling branches', () => {
    // Expected opacity per node: ancestors of the zoomed node are dimmed.
    for (const [zoomed, expected] of [[3, [0.65, 1, 1, 1, 1]], [4, [0.65, 1, 1, 0.65, 1]]]) {
        const { chart, flush, load, recordFills } = createChart(1000, 170, 1, false);
        const values = [100, 40, 20, 60, 30];
        const fills = recordFills();
        const alphas = new Map();

        chart.colorMapper = indexColor;
        load(frameTree([0, 0, 1, 0, 3], [4, 1, 0, 1, 0]), values);
        flush(0);
        fills.length = 0;
        chart.zoomFrame(zoomed, false, 'continuous');
        flush(16);

        for (let i = 0; i < fills.length; i++) {
            alphas.set(fillNode(fills[i]), fills[i].alpha);
        }

        for (let i = 0; i < values.length; i++) {
            assert.equal(alphas.get(i), expected[i], `Node ${i} while zooming into ${zoomed}`);
        }

        assert.equal(chart.findFrameAt(100, 22), 1);
        chart.destroy();
    }
});

test('picked deep zoom settles overlapping motion and reveal without restarting for the same target', () => {
    const { chart, flush, scheduled, load } = createChart(1000, 170, 1, false);
    const frameCounts = [];

    load(frameTree([0, 0, 0], [2, 0, 0]), [1000, 1, 999]);
    flush(0);

    for (const node of [1, 0]) {
        let frames = 0;

        chart.zoomFrame(node);

        while (scheduled.size > 0 && frames < 120) {
            chart.zoomFrame(node);
            flush();
            frames++;
        }

        assert.ok(frames < 50, `Deep picked zoom took ${frames} frames`);
        assert.equal(scheduled.size, 0);
        frameCounts.push(frames);
    }

    assert.ok(
        frameCounts[1] - frameCounts[0] <= 15,
        'Reveal has a finite tail rather than another exponential settling period'
    );
    assert.equal(chart.findFrameAt(0.5, 22), 1);
    assert.equal(chart.findFrameAt(900, 22), 2);

    chart.destroy();
});

test('picked zoom out reveals new frames over the tail of retained movement', () => {
    const { chart, flush, settle, load, recordFills } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    load(tree, values);
    flush(0);
    chart.zoomFrame(1);
    settle();

    const fills = recordFills();
    const rowFill = left => fills.find(fill => fill.top === 17 && fill.left === left);

    chart.resetZoom();
    flush(65);

    assert.equal(rowFill(400), undefined);
    assert.ok(rowFill(0).width > 600 && rowFill(0).width < 650);
    assert.equal(chart.findFrameAt(500, 22), 1);
    assert.equal(chart.findFrameAt(900, 22), -1);

    let arriving;
    let revealTime = 65;

    for (let i = 0; i < 120; i++) {
        fills.length = 0;
        flush();
        revealTime += 1000 / 60;
        arriving = rowFill(400);

        if (arriving) {
            const width = rowFill(0).width;

            assert.ok(width > 399 && width <= 414, `Expected late residual movement at reveal, got ${width}`);
            break;
        }

        assert.equal(chart.findFrameAt(900, 22), -1);
    }

    // Reveal waits for 60% of the motion time 65 ms * ln(600px / 0.25px).
    assert.ok(arriving, 'New frames eventually fade in');
    assert.ok(revealTime >= 65 * Math.log(600) * 0.6);
    assert.ok(revealTime <= 65 * Math.log(600) * 0.6 + 1000 / 60, 'Reveal follows the accepted delay factor');
    assert.equal(arriving.width, 599);
    assert.ok(arriving.alpha > 0 && arriving.alpha < 1);

    settle();
    assert.equal(chart.findFrameAt(900, 22), 3);

    chart.destroy();
});

test('picked zoom and reveal depend on elapsed time, not frame cadence', () => {
    const scenarios = [
        {
            dpr: 2,
            from: 0,
            to: 1,
            cadences: [new Array(6).fill(100 / 6), new Array(12).fill(100 / 12)]
        },
        {
            dpr: 1,
            from: 1,
            to: 0,
            cadences: [
                new Array(24).fill(1000 / 60),
                new Array(48).fill(1000 / 120),
                [100, 200, 100],
                [400]
            ],
            check(row) {
                const arriving = row.find(fill => fill.left === 400);
                const retained = row.find(fill => fill.left === 0);

                assert.ok(retained.width >= 399 && retained.width < 401);
                assert.ok(arriving, 'New frames gradually appear near their final geometry');
                assert.ok(arriving.alpha > 0.1 && arriving.alpha < 0.9);
            }
        }
    ];

    for (const scenario of scenarios) {
        const snapshots = [];

        for (const intervals of scenario.cadences) {
            const { chart, flush, settle, load, recordFills } = createChart(1000, 170, scenario.dpr, false);
            const { tree, values } = fixture();

            load(tree, values);
            flush(0);
            chart.zoomFrame(scenario.from);
            settle();

            const fills = recordFills();

            chart.zoomFrame(scenario.to);

            for (let i = 0; i < intervals.length; i++) {
                fills.length = 0;
                flush(intervals[i]);
            }

            scenario.check?.(fills.filter(fill => fill.top === 17));
            snapshots.push(fills.slice());
            chart.destroy();
        }

        for (let i = 1; i < snapshots.length; i++) {
            assert.equal(snapshots[i].length, snapshots[0].length);

            for (let j = 0; j < snapshots[i].length; j++) {
                const actual = snapshots[i][j];
                const expected = snapshots[0][j];

                assert.equal(actual.color, expected.color);

                for (const field of ['left', 'top', 'width', 'height', 'alpha']) {
                    assert.ok(Math.abs(actual[field] - expected[field]) < 1e-8, `${field} of fill ${j}`);
                }
            }
        }
    }
});

test('picked motion retargets from the displayed geometry and opacity', () => {
    const cases = [
        {
            dpr: 2,
            from: 0,
            to: 1,
            elapsed: 100,
            settled: [[0, 399, 1], [400, 599, 1]]
        },
        {
            dpr: 1,
            from: 1,
            to: 0,
            elapsed: 100,
            settled: [[0, 999, 1]]
        },
        {
            dpr: 1,
            from: 1,
            to: 0,
            elapsed: 550,
            settled: [[0, 999, 1]]
        }
    ];

    for (const row of cases) {
        const { chart, flush, settle, elements, load, recordFills } = createChart(1000, 170, row.dpr, false);
        const { tree, values } = fixture();
        const fills = recordFills();
        const depthFills = () => fills.filter(fill => fill.top === 17).sort((left, right) => left.left - right.left);

        load(tree, values);
        flush(0);
        chart.zoomFrame(row.from);
        settle();
        chart.zoomFrame(row.to);
        fills.length = 0;
        flush(row.elapsed);

        const before = depthFills();

        chart.zoomFrame(row.from);
        fills.length = 0;
        flush(0);

        assert.deepEqual(depthFills(), before, `Retargeting after ${row.elapsed} ms starts at the displayed frame`);

        settle();
        fills.length = 0;
        chart.render();

        assert.deepEqual(depthFills().map(fill => [fill.left, fill.width, fill.alpha]), row.settled);
        assert.equal(elements.length, 3);
        chart.destroy();
    }
});

test('picked transitions keep own-parent bounds during retargeting and vertical scrolling', () => {
    const { chart, scroll, flush, settle, load, recordFills, scrollTo } = createChart(1000, 51, 2, false);
    const tree = frameTree([0, 0, 1, 0, 3], [4, 1, 0, 1, 0]);
    const fills = recordFills();
    const checkFrame = () => {
        const painted = new Map();

        for (let i = 0; i < fills.length; i++) {
            const fill = fills[i];
            const node = fillNode(fill);

            assert.equal(chart.nodesDepth[node], Math.round((fill.top + scroll.scrollTop) / 17));
            painted.set(node, fill);

            if (node !== 0 && fill.top >= 17) {
                const parent = painted.get(tree.parent[node]);

                assert.ok(parent);
                assert.ok(fill.left >= parent.left - 1e-8);
                assert.ok(fill.left + fill.width <= parent.left + parent.width + 1e-8);
            }
        }

        fills.length = 0;
    };

    chart.colorMapper = indexColor;
    load(tree, [100, 40, 20, 60, 30]);
    flush(0);
    checkFrame();

    for (const node of [1, 3, 0]) {
        chart.zoomFrame(node);

        for (let i = 0; i < 6; i++) {
            flush();
            checkFrame();
        }

        scrollTo(scroll.scrollTop === 0 ? 17 : 0);
        flush();
        checkFrame();
    }

    settle(checkFrame);
    chart.destroy();
});

test('new zoom-in descendants reveal at destination bounds clipped by their moving parent', () => {
    const { chart, flush, settle, load, recordFills } = createChart(1000, 170, 1, false);

    chart.colorMapper = indexColor;
    load(frameTree([0, 0, 1, 1, 0], [4, 2, 0, 0, 0]), [1000, 10, 9, 1, 990]);
    flush(0);

    const fills = recordFills();

    chart.zoomFrame(1);
    settle();

    const arrivals = fills.filter(fill => fillNode(fill) === 3);

    assert.ok(arrivals.length > 0);

    for (let i = 0; i < arrivals.length; i++) {
        const frame = arrivals[i];

        assert.equal(frame.left, 900);
        assert.ok(frame.width >= 80 && frame.width <= 99, `New frame has excessive residual growth: ${frame.width}`);

        if (frame.alpha >= 0.9) {
            assert.ok(frame.width >= 98, 'Nearly opaque arrivals are within one pixel of their final width');
        }
    }

    const intermediate = arrivals.filter(frame => frame.alpha > 0.1 && frame.alpha < 0.9);

    assert.ok(intermediate.length >= 6, 'Appearance remains readable over several frames');
    chart.destroy();
});

test('vertical scrolling does not restart the reveal clock for rows that stay visible', () => {
    const snapshots = [];

    for (const scrollDuringReveal of [false, true]) {
        const { chart, scroll, flush, load, recordFills, scrollTo } = createChart(1000, 100, 1, false);
        const { tree, values } = fixture();

        load(tree, values);
        flush(0);
        chart.zoomFrame(1);
        flush(2000);

        const fills = recordFills();

        // New frames start fading in about 250 ms after a 600px zoom out and need another 250 ms.
        chart.resetZoom();
        flush(300);

        if (scrollDuringReveal) {
            scrollTo(1);
        }

        flush(0);
        fills.length = 0;
        flush(30);

        const arriving = fills.find(fill => fill.top + scroll.scrollTop === 17 && fill.left === 400);

        assert.ok(arriving.alpha > 0 && arriving.alpha < 1);
        snapshots.push([arriving.left, arriving.width, arriving.alpha]);
        chart.destroy();
    }

    assert.deepEqual(snapshots[1], snapshots[0]);
});

test('scrolling reveals existing rows immediately even during zoom or metric motion', () => {
    for (const update of ['none', 'zoom', 'metrics']) {
        const { chart, flush, settle, load, recordFills, scrollTo } = createChart(1000, 51, 1, false);
        const { tree, values } = deepChain(12);

        load(tree, values);
        flush(0);

        if (update === 'zoom') {
            chart.zoomFrame(1);
            flush(20);
        } else if (update === 'metrics') {
            values[1] = 50;
            values[11] = 50;
            chart.resetValues();
            flush(0);
            flush(20);
        }

        const fills = recordFills();

        scrollTo(5 * 17);
        flush(0);

        const visible = fills.filter(fill => fill.top + 16 > 0 && fill.top < 51);

        assert.equal(visible.length, 3, `${update}: entering rows are drawn on the scroll frame`);

        for (let i = 0; i < visible.length; i++) {
            assert.equal(visible[i].alpha, 1, `${update}: scrolling does not introduce fade-in`);
        }

        assert.equal(chart.findFrameAt(100, 5), 5);
        assert.equal(chart.findFrameAt(100, 22), 6);
        assert.equal(chart.findFrameAt(100, 39), 7);

        settle();
        chart.destroy();
    }
});

test('scrolling paints only viewport rows while the layout keeps every row, including departing ones', () => {
    const { chart, canvas, flush, settle, load, recordFills, scrollTo } = createChart(1000, 51, 1, false);
    const { tree, values } = deepChain(22);
    const fills = recordFills();

    load(tree, values);
    flush(0);

    // 21 rows of 17px and a 2px margin.
    assert.equal(chart.el.style.height, '359px');

    chart.zoomFrame(1);
    fills.length = 0;
    flush(65);

    const before = fills.slice();

    for (const offset of [5 * 17, 10 * 17 + 16.5]) {
        scrollTo(offset);
        fills.length = 0;
        canvas.context.fillText.mockClear();
        flush(0);

        assert.equal(fills.length, 3);
        assert.equal(canvas.context.fillText.mock.calls.length, 3);

        for (let i = 0; i < fills.length; i++) {
            assert.ok(fills[i].top + fills[i].height > 0 && fills[i].top < 51);
        }

        const labels = canvas.context.fillText.mock.calls;

        for (let i = 0; i < labels.length; i++) {
            const top = labels[i][2];

            assert.ok(top >= 0 && top < 51);
        }
    }

    scrollTo(0);
    fills.length = 0;
    flush(0);

    assert.deepEqual(fills, before);

    // Zooming into the leaf at depth 1 keeps the departing chain in the layout until the motion settles.
    chart.zoomFrame(21);
    flush(20);
    assert.equal(chart.el.style.height, '359px');

    settle();
    assert.equal(chart.el.style.height, '172px');
    chart.destroy();
});

test('offscreen transition rows advance without per-row work and are restored on demand', () => {
    const snapshots = [];

    for (const scrollDuringMotion of [false, true]) {
        const { chart, flush, settle, scheduled, load, recordFills, scrollTo } = createChart(1000, 51, 1, false);
        const { tree, values } = deepChain(22);
        const fills = recordFills();

        load(tree, values);
        flush(0);
        chart.zoomFrame(1);
        flush(20);

        if (scrollDuringMotion) {
            for (const offset of [17, 2 * 17 + 16.5]) {
                scrollTo(offset);
                flush(0);
            }
        }

        const absSpy = vi.spyOn(Math, 'abs');
        const originalPush = Array.prototype.push;
        let boundsWrites = 0;
        let absCalls = 0;

        Array.prototype.push = function(...items) {
            if (items.length === 2 && items.every(item => typeof item === 'number')) {
                boundsWrites++;
            }

            return originalPush.apply(this, items);
        };

        try {
            flush(45);
        } finally {
            Array.prototype.push = originalPush;
            absCalls = absSpy.mock.calls.length;
            absSpy.mockRestore();
        }

        assert.ok(boundsWrites <= 4, `Only viewport bounds are interpolated, got ${boundsWrites} writes`);
        assert.equal(absCalls, 0, 'Convergence uses prepared maxima, not per-node differences');
        assert.equal(scheduled.size, 1);

        scrollTo(0);
        fills.length = 0;
        flush(0);
        snapshots.push({
            fills: fills.slice(),
            hits: [5, 22, 39].map(top => [100, 700, 999].map(left => chart.findFrameAt(left, top)))
        });

        if (scrollDuringMotion) {
            assert.equal(chart.findFrameAt(100, 3 * 17 + 5), 3);
            flush(100);
            assert.equal(
                chart.findFrameAt(100, 3 * 17 + 5),
                -1,
                'Offscreen picking observes the current departure opacity'
            );
        }

        settle();
        chart.destroy();
    }

    assert.deepEqual(snapshots[1], snapshots[0]);
});

test('transition preparation reuses row lookups and skips empty-depth work', () => {
    const { chart, flush, settle, load, scrollTo } = createChart(1000, 51, 1, false);
    const { tree, values } = deepChain(102);
    const OriginalMap = globalThis.Map;
    let maps = 0;
    let entryPairs = 0;
    let keyIterators = 0;
    let sorts = 0;
    let copies = 0;

    load(tree, values);
    flush(0);
    scrollTo(80 * 17);
    flush(0);

    vi.stubGlobal('Map', class extends OriginalMap {
        constructor(...args) {
            super(...args);
            maps++;
            entryPairs += args[0]?.length || 0;
        }

        keys() {
            keyIterators++;

            return super.keys();
        }
    });

    const originalSort = Array.prototype.sort;
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function(compare) {
        sorts++;
        return originalSort.call(this, compare);
    });
    const originalSlice = Array.prototype.slice;
    const sliceSpy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function(...args) {
        copies++;
        return originalSlice.apply(this, args);
    });

    try {
        chart.zoomFrame(1);
        flush(0);

        assert.ok(maps <= 5, `Row lookups are reused across depths, got ${maps} maps`);
        assert.equal(entryPairs, 0, 'Lookup construction does not materialize entry-pair arrays');
        assert.equal(keyIterators, 0, 'Node collection shares the source and target lookup traversals');
        assert.equal(sorts, 0, 'Single-node and empty rows need no sorting');
        assert.equal(chart.findFrameAt(100, 5), 80);

        maps = 0;
        keyIterators = 0;
        scrollTo(81 * 17);
        flush(0);

        assert.ok(maps <= 4, `Continuation shares source and origin positions, got ${maps} maps`);
        assert.equal(entryPairs, 0);
        assert.equal(keyIterators, 0, 'Continuation needs no additional lookup-key traversal');
        assert.equal(copies, 0, 'Continuation reads old origins without copying every row');
        assert.equal(sorts, 0);
        assert.equal(chart.findFrameAt(100, 5), 81);
    } finally {
        sortSpy.mockRestore();
        sliceSpy.mockRestore();
    }

    settle();
    chart.destroy();
});

test('settled projection is reused by paint-only updates and rebuilt by layout, LOD, zoom and metric changes', () => {
    const { chart, canvas, scroll, pointer, flush, resize, load, scrollTo } = createChart(1000, 34);
    const { tree, values } = fixture();
    let descendantReads = 0;

    load(tree, values, { childrenSort: true });
    flush(0);
    // Root content may read the root coordinate; any descendant read means the projection was rebuilt.
    chart.nodesX = new Proxy(chart.nodesX, {
        get(target, property) {
            if (typeof property === 'string' && property !== '0' && /^\d+$/.test(property)) {
                descendantReads++;
            }

            return Reflect.get(target, property, target);
        }
    });

    for (const update of [
        () => pointer('pointermove', 100, 22),
        () => chart.selectFrame(1),
        () => chart.colorMapper = () => '100, 150, 200',
        () => chart.colorHue = 'blue',
        () => globalThis.document.fonts.dispatchEvent(new Event('loadingdone')),
        () => resize(),
        () => chart.scheduleRender()
    ]) {
        descendantReads = 0;
        canvas.context.fillRect.mockClear();
        update();
        flush();

        assert.ok(canvas.context.fillRect.mock.calls.length > 0, 'The requested repaint still happens');
        assert.equal(descendantReads, 0, 'Paint-only updates do not traverse descendant coordinates');
        assert.equal(chart.findFrameAt(650, 22), 1);
    }

    const checkUpdate = (update, verify) => {
        update();
        descendantReads = 0;
        flush();

        assert.ok(descendantReads > 0, 'Changed geometry rebuilds the projection');
        verify();
        descendantReads = 0;
        chart.render();
        assert.equal(descendantReads, 0, 'The next unchanged draw reuses the new projection');
    };

    checkUpdate(() => resize(500), () => {
        assert.equal(chart.findFrameAt(350, 22), 1);
        assert.equal(chart.findFrameAt(100, 39), -1);
        assert.equal(canvas.width, 500);
    });
    checkUpdate(() => {
        scroll.clientHeight = 51;
        resize();
    }, () => {
        assert.equal(chart.findFrameAt(350, 39), 2);
        assert.equal(canvas.height, 51);
    });
    checkUpdate(() => scrollTo(17), () => {
        assert.equal(chart.findFrameAt(100, 5), 3);
        assert.equal(chart.findFrameAt(350, 22), 2);
    });
    checkUpdate(() => {
        globalThis.window.devicePixelRatio = 2;
        resize();
    }, () => {
        assert.equal(canvas.width, 1000);
        assert.equal(canvas.height, 102);
    });
    checkUpdate(() => chart.minFrameWidth = 200, () => {
        assert.equal(chart.findFrameAt(475, 22), 2);
    });
    checkUpdate(() => {
        chart.zoomStart = 0.6;
        chart.zoomEnd = 1;
        chart.scheduleRender();
    }, () => {
        assert.equal(chart.findFrameAt(100, 5), 1);
    });
    checkUpdate(() => chart.resetZoom(), () => {
        assert.equal(chart.findFrameAt(100, 5), 3);
    });
    checkUpdate(() => chart.zoomFrame(1), () => {
        assert.equal(chart.findFrameAt(100, 5), 1);
    });
    checkUpdate(() => {
        values.splice(0, values.length, 100, 70, 35, 30, 15);
        chart.resetValues();
        chart.getVisibleFrames();
    }, () => {
        assert.equal(chart.zoomStart, 0);
        assert.equal(chart.zoomEnd, 0.7);
        assert.equal(chart.findFrameAt(100, 5), 1);
    });

    const replacement = fixture();

    load(replacement.tree, replacement.values);
    flush();
    assert.equal(chart.findFrameAt(250, 5), 3);
    assert.equal(chart.zoomedNode, 0);
    chart.destroy();
});

test('viewport height and LOD changes refresh target rows during an active transition', () => {
    const { chart, scroll, canvas, flush, settle, resize, load } = createChart(1000, 17, 1, false);
    const { tree, values } = fixture();

    load(tree, values, { childrenSort: true });
    flush(0);
    chart.zoomFrame(1);
    flush(20);
    scroll.clientHeight = 51;
    resize();
    flush(0);

    assert.equal(canvas.height, 51);
    assert.equal(chart.findFrameAt(100, 22), 1);
    assert.equal(chart.findFrameAt(700, 39), -1);

    chart.minFrameWidth = 600;
    flush(0);

    assert.equal(chart.findFrameAt(550, 39), 2);

    settle();
    assert.equal(chart.findFrameAt(550, 39), 2);
    chart.destroy();
});

test('metric reordering moves stable nodes from their displayed geometry and retargets mid-motion', () => {
    const { chart, canvas, flush, settle, elements, load, recordFills } = createChart(1000, 170, 2, false);
    const tree = frameTree([0, 0, 1, 0, 3], [4, 1, 0, 1, 0]);
    const values = [100, 40, 20, 60, 30];
    const fills = recordFills();
    const renderRoot = vi.fn();
    const byNode = () => new Map(fills.map(fill => [fillNode(fill), fill]));
    // Picking follows the topmost visible fill, then its separator.
    const expectedPick = (row, x) => {
        let hit = row.findLast(fill => x >= fill.left && x < fill.left + fill.width);

        if (hit === undefined) {
            hit = row.findLast(fill => x >= fill.left && x < fill.left + fill.width + 1);
        }

        return hit === undefined ? -1 : fillNode(hit);
    };
    // Children stay inside their parents and are picked where they are displayed.
    const checkFrame = () => {
        const painted = byNode();

        for (const [node, fill] of painted) {
            if (node !== 0) {
                const parent = painted.get(tree.parent[node]);

                assert.ok(parent);
                assert.ok(fill.left >= parent.left - 1e-8);
                assert.ok(fill.left + fill.width <= parent.left + parent.width + 1e-8);
            }
        }

        for (const top of [17, 34]) {
            const row = fills.filter(fill => fill.top === top && fill.alpha > 0.01);

            for (let x = 0.5; x < 1000; x += 37) {
                assert.equal(chart.findFrameAt(x, top + 5), expectedPick(row, x));
            }
        }

        fills.length = 0;
    };

    chart.colorMapper = indexColor;
    chart.on('render', renderRoot);
    load(tree, values, { childrenSort: true });
    flush(0);

    const initial = byNode();

    values.splice(0, values.length, 200, 140, 70, 60, 30);
    chart.resetValues();
    fills.length = 0;
    flush(0);

    assert.deepEqual(byNode(), initial, 'Metric updates begin at the displayed frame');

    fills.length = 0;
    flush(40);

    const moving = byNode();

    assert.ok(moving.get(1).left > 0 && moving.get(1).left < 600);
    assert.ok(moving.get(3).left > 0 && moving.get(3).left < 700);
    checkFrame();

    values.splice(0, values.length, 100, 30, 15, 70, 35);
    chart.resetValues();
    fills.length = 0;
    flush(0);

    assert.deepEqual(byNode(), moving, 'Retargeting begins at the displayed frame');

    fills.length = 0;
    settle(checkFrame);

    assert.equal(elements.length, 3);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);
    assert.equal(renderRoot.mock.calls.length, 3);
    assert.equal(renderRoot.mock.calls.at(-1)[2], 100);

    chart.render();

    const settled = byNode();

    assert.deepEqual([settled.get(3).left, settled.get(3).width], [0, 699]);
    assert.deepEqual([settled.get(1).left, settled.get(1).width], [700, 299]);
    assert.equal(chart.findFrameAt(100, 22), 3);
    assert.equal(chart.findFrameAt(800, 22), 1);
    chart.destroy();
});

test('metric targets received every frame do not pause active motion', () => {
    const cases = [
        {
            zoomed: false,
            top: 17,
            first: 70,
            initialWidth: 399,
            // A spans A% of the width.
            targetWidth: values => values[1] * 10 - 1,
            node: 1
        },
        {
            zoomed: true,
            top: 34,
            first: 40,
            initialWidth: 499,
            // Zoomed into A, B spans B / A of the width.
            targetWidth: values => values[2] / values[1] * 1000 - 1,
            node: 2
        }
    ];

    for (const row of cases) {
        const { chart, canvas, flush, settle, scheduled, load } = createChart(1000, 170, 1, false);
        const { tree, values } = fixture();
        let previousWidth = row.initialWidth;

        load(tree, values);
        flush(0);

        if (row.zoomed) {
            chart.zoomFrame(1);
            flush(1000);
        }

        values[1] = row.first;
        values[2] = 30;
        values[3] = 100 - values[1];
        chart.resetValues();
        flush(0);

        try {
            for (let i = 1; i <= 8; i++) {
                values[1] = row.first + i;
                values[2] = 30 + i;
                values[3] = 100 - values[1];
                chart.resetValues();
                canvas.context.fillRect.mockClear();
                flush(16);

                const rect = canvas.context.fillRect.mock.calls.find(([left, top]) => left === 0 && top === row.top);
                const currentWidth = rect[2];

                assert.ok(
                    currentWidth > previousWidth,
                    `Frame ${i} must advance despite a new target (zoomed: ${row.zoomed})`
                );
                assert.ok(currentWidth < row.targetWidth(values), 'The new target is approached, not snapped to');
                assert.equal(scheduled.size, 1);
                previousWidth = currentWidth;
            }

            settle();
            assert.equal(chart.findFrameAt(100, row.top + 5), row.node);
        } finally {
            chart.destroy();
        }
    }
});

test('repeated metric targets do not restart the appearance of an already targeted node', () => {
    const { chart, flush, load, recordFills } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const fills = recordFills();
    // B under A starts at the left edge of depth 2; an unpainted B has no opacity.
    const arrivalAlpha = () => {
        const arrival = fills.find(fill => fill.left === 0 && fill.top === 34);

        return arrival === undefined ? 0 : arrival.alpha;
    };

    values[2] = 0;
    load(tree, values);
    flush(0);
    values[1] = 80;
    values[2] = 10;
    values[3] = 20;
    chart.resetValues();
    fills.length = 0;
    flush(0);
    assert.equal(arrivalAlpha(), 0);

    try {
        let opacity = 0;

        for (let i = 1; i <= 40; i++) {
            const previousOpacity = opacity;

            values[1] = i % 2 === 0 ? 80 : 70;
            values[3] = 100 - values[1];
            chart.resetValues();
            fills.length = 0;
            flush(16);
            opacity = arrivalAlpha();

            assert.ok(opacity > previousOpacity, `Appearance must advance on retargeted frame ${i}`);
        }

        assert.ok(opacity > 0.9, 'The arriving node becomes visible while input is still changing');
        assert.equal(chart.findFrameAt(20, 40), 2);
    } finally {
        chart.destroy();
    }
});

test('metric animation handles disappearing zoom nodes, zero data and later reappearance', () => {
    const { chart, canvas, flush, scheduled, load } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const zoom = vi.fn();

    chart.on('zoom', zoom);
    load(tree, values, { childrenSort: true });
    flush(0);
    chart.zoomFrame(1);
    flush(2000);
    chart.selectFrame(2);
    flush(0);
    canvas.context.fillRect.mockClear();
    chart.render();

    const before = canvas.context.fillRect.mock.calls.map(rect => rect.slice());

    values.splice(0, values.length, 100, 0, 0, 100, 50);
    chart.resetValues();
    // Inspecting geometry before the next frame must not consume the pending transition.
    chart.getVisibleFrames();
    canvas.context.fillRect.mockClear();
    flush(0);

    assert.equal(chart.zoomedNode, 0);
    assert.equal(zoom.mock.calls.at(-1)[0], 0);
    assert.equal(chart.selectedNode, 2);
    assert.deepEqual(canvas.context.fillRect.mock.calls, before);
    flush(2000);
    assert.equal(chart.findFrameAt(500, 22), 3);

    values.fill(0);
    chart.resetValues();
    flush(0);
    flush(2000);

    assert.equal(chart.findFrameAt(100, 22), -1);
    assert.equal(scheduled.size, 0);

    values.splice(0, values.length, 100, 40, 20, 60, 30);
    chart.resetValues();
    canvas.context.fillRect.mockClear();
    flush(0);

    assert.equal(canvas.context.fillRect.mock.calls.length, 0);
    assert.equal(chart.findFrameAt(100, 22), -1);
    flush(2000);

    assert.equal(chart.findFrameAt(100, 22), 3);
    assert.equal(chart.findFrameAt(800, 22), 1);
    assert.equal(scheduled.size, 0);
    assert.equal(chart.selectedNode, 2);
    chart.destroy();
});
