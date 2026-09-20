import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { FlameChart } from './flamechart/index.js';
import { CallTree } from '../prepare/computations/call-tree.js';

afterEach(() => vi.unstubAllGlobals());

function createChart(width = 1000, height = 170, dpr = 1) {
    const scheduled = new Map();
    const elements = [];
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
    vi.stubGlobal('window', { devicePixelRatio: dpr });
    vi.stubGlobal('getComputedStyle', () => ({ color: '#ccc' }));
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
    const flush = () => {
        const callbacks = [...scheduled.values()];

        scheduled.clear();
        callbacks.forEach(callback => callback());
    };
    const pointer = (type, x, y, metaKey = false) => {
        const event = new Event(type);

        Object.assign(event, { clientX: x, clientY: y, metaKey });
        canvas.dispatchEvent(event);
    };

    return {
        chart,
        canvas,
        scroll,
        elements,
        flush,
        pointer,
        scheduled,
        resize: () => resize()
    };
}

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

test('canvas flame graph preserves lazy sorted tree geometry and root content', () => {
    const { chart, canvas, elements, flush } = createChart();
    const { tree, values } = fixture();
    let root;

    chart.on('render', (...args) => root = args);
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush();

    assert.deepEqual(chart.getVisibleFrames().map(frame => [frame.nodeIndex, frame.depth, frame.x0, frame.x1]), [
        [0, 0, 0, 1],
        [1, 1, 0.6, 1],
        [2, 2, 0.6, 0.8],
        [3, 1, 0, 0.6],
        [4, 2, 0, 0.3]
    ]);
    assert.equal(chart.findFrameAt(100, 20), 3);
    assert.equal(chart.findFrameAt(650, 20), 1);
    assert.equal(chart.findFrameAt(650, 40), 2);
    assert.equal(chart.findFrameAt(100, 33), -1);
    assert.equal(root[0], chart.el.children[1]);
    assert.notEqual(root[0], canvas);
    assert.equal(root[1].value, tree.dictionary[0]);
    assert.equal(root[2], 100);
    assert.equal(elements.length, 3);

    chart.destroy();
});

test('canvas picking preserves click zoom, meta selection, similar identity and tooltip events', () => {
    const { chart, canvas, pointer, flush } = createChart();
    const { tree, values } = fixture();
    const enter = vi.fn();
    const leave = vi.fn();

    chart
        .on('frame:enter', enter)
        .on('frame:leave', leave);
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush();

    pointer('pointermove', 650, 40);
    assert.equal(enter.mock.calls.at(-1)[0], 2);

    pointer('click', 650, 40, true);
    flush();
    assert.equal(chart.selectedNode, 2);

    pointer('click', 100, 40, true);
    assert.equal(chart.selectedNode, -1);

    pointer('click', 650, 20);
    flush();
    assert.equal(chart.zoomedNode, 1);
    assert.equal(chart.zoomStart, 0.6);
    assert.equal(chart.zoomEnd, 1);
    assert.equal(chart.findFrameAt(100, 40), 2);

    pointer('click', 100, 40);
    flush();
    assert.equal(chart.zoomedNode, 2);

    pointer('click', 100, 40);
    flush();
    assert.equal(chart.zoomedNode, 1);

    pointer('pointerleave', 0, 0);
    assert.ok(leave.mock.calls.length > 0);
    assert.ok(canvas.context.fillRect.mock.calls.length > 0);

    chart.destroy();
});

test('metric updates recover zoom geometry, handle zero values and replace tree identities', () => {
    const { chart, flush } = createChart();
    const { tree, values } = fixture();

    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush();
    chart.zoomFrame(2);
    flush();

    values[1] = 70;
    values[2] = 35;
    values[3] = 30;
    chart.resetValues();
    flush();

    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 0.35);

    values.fill(0);
    chart.resetValues();
    flush();

    assert.equal(chart.zoomedNode, 0);
    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 1);
    assert.equal(chart.findFrameAt(100, 20), -1);

    const replacement = fixture();

    chart.setData(replacement.tree, { value: index => replacement.values[index] });
    flush();

    assert.equal(chart.selectedNode, -1);
    assert.equal(chart.getVisibleFrames()[1].value, replacement.tree.dictionary[1]);

    chart.destroy();
});

test('canvas resources are viewport-sized and reused, with cancellable destruction', () => {
    const { chart, canvas, elements, scroll, flush, resize, scheduled } = createChart(800, 100, 2);
    const { tree, values } = fixture();

    chart.setData(tree, { value: index => values[index] });
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

    scroll.scrollTop = 17;
    scroll.dispatchEvent(new Event('scroll'));
    flush();

    assert.equal(chart.findFrameAt(100, 5), 1);

    chart.scheduleRender();
    assert.ok(scheduled.size);

    chart.destroy();
    chart.destroy();
    assert.equal(scheduled.size, 0);

    chart.resetValues();
    assert.equal(scheduled.size, 0);
});

test('subpixel siblings retain occupied width and reveal original nodes on zoom', () => {
    const { chart, canvas, flush } = createChart(100, 100);
    const count = 10000;
    const nodes = Uint32Array.from({ length: count + 1 }, (_, index) => index);
    const tree = new CallTree(Array.from(nodes, index => ({ name: `Frame ${index}` })), nodes);

    tree.subtreeSize[0] = count;
    chart.setData(tree, {
        value: index => index === 0 ? count : 1,
        childrenSort: true
    });
    flush();

    const row = canvas.context.fillRect.mock.calls.filter(([, top]) => top === 17);

    assert.equal(row.reduce((width, [, , value]) => width + value, 0), 99);
    assert.equal(row.length, 50);

    const node = chart.findFrameAt(50, 20);

    assert.ok(node > 0);
    chart.zoomFrame(node);
    flush();

    assert.equal(chart.findFrameAt(50, 20), node);
    assert.equal(tree.nodes.length, count + 1);

    chart.destroy();
});

test('LOD preserves self-time gaps and reveals narrow descendants on zoom', () => {
    const { chart, flush } = createChart(100);
    const { tree } = fixture();
    const values = [1000, 1, 1, 999, 1];

    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush();

    assert.equal(chart.findFrameAt(50, 20), 3);
    assert.equal(chart.findFrameAt(99.95, 20), -1);
    assert.equal(chart.findFrameAt(50, 40), -1);

    chart.zoomFrame(1);
    flush();
    assert.equal(chart.findFrameAt(50, 40), 2);

    chart.destroy();
});

test('LOD markers do not displace resolvable frames or capture their hit targets', () => {
    const cases = [
        {
            parent: [0, 0, 0],
            subtreeSize: [2, 0, 0],
            values: [1000, 1, 999],
            depth: 1,
            node: 2,
            start: 0.1,
            end: 100
        },
        {
            parent: [0, 0, 1, 1, 0, 4],
            subtreeSize: [5, 2, 0, 0, 1, 0],
            values: [1000, 500, 499, 1, 500, 500],
            childrenSort: true,
            depth: 2,
            node: 5,
            start: 50,
            end: 100
        }
    ];

    for (const dpr of [1, 1.5, 2]) {
        for (const entry of cases) {
            const { chart, canvas, flush } = createChart(100, 100, dpr);
            const nodes = Uint32Array.from(entry.values, (_, index) => index);
            const tree = new CallTree(
                Array.from(nodes, index => ({ name: `Frame ${index}` })),
                nodes,
                new Uint32Array(entry.parent),
                new Uint32Array(entry.subtreeSize)
            );

            chart.setData(tree, {
                value: index => entry.values[index],
                childrenSort: entry.childrenSort
            });
            flush();

            const row = canvas.context.fillRect.mock.calls.filter(([, top]) => top === entry.depth * 17);

            assert.deepEqual(row.at(-1), [entry.start, entry.depth * 17, entry.end - entry.start - 1, 16]);
            assert.equal(chart.findFrameAt(entry.start + 0.01, entry.depth * 17 + 5), entry.node);

            for (let index = 1; index < row.length; index++) {
                assert.ok(row[index - 1][0] + row[index - 1][2] <= row[index][0]);
            }

            chart.destroy();
        }
    }
});

test('viewport clipping does not move an offscreen frame border into the visible area', () => {
    const { chart, canvas, flush } = createChart(100, 100);
    const { tree, values } = fixture();

    chart.setData(tree, { value: index => values[index] });
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
    assert.equal(chart.findFrameAt(99.75, 40), -1);

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

    for (const entry of cases) {
        for (const dpr of [1, 1.5, 2]) {
            const { chart, canvas, flush } = createChart(100, 100, dpr);
            const nodes = Uint32Array.from(entry.values, (_, index) => index);
            const tree = new CallTree(
                Array.from(nodes, index => ({ name: `Frame ${index}` })),
                nodes,
                new Uint32Array(entry.parent),
                new Uint32Array(entry.subtreeSize)
            );

            chart.setData(tree, { value: index => entry.values[index] });
            flush();

            for (const [start, end] of [[0, 1], [0.0435, 0.9]]) {
                const painted = new Map();

                canvas.context.fillRect.mockClear();
                chart.zoomStart = start;
                chart.zoomEnd = end;
                chart.render();

                for (const [left, top, width] of canvas.context.fillRect.mock.calls) {
                    if (width <= 0) {
                        continue;
                    }

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

            chart.destroy();
        }
    }
});

test('scrolling keeps ancestor clipping without accumulating border offsets at each depth', () => {
    const { chart, canvas, scroll, flush } = createChart(100, 17, 1.5);
    const count = 20;
    const tree = new CallTree(
        [{ name: 'Frame' }],
        new Uint32Array(count),
        Uint32Array.from({ length: count }, (_, index) => Math.max(0, index - 1)),
        Uint32Array.from({ length: count }, (_, index) => count - index - 1)
    );

    chart.setData(tree, { value: () => 1000 });
    flush();
    canvas.context.fillRect.mockClear();

    scroll.scrollTop = 4 * 17 + 0.25;
    scroll.dispatchEvent(new Event('scroll'));
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
