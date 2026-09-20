import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { FlameChart } from './flamechart/index.js';
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
    vi.stubGlobal('getComputedStyle', () => ({
        color: '#ccc',
        getPropertyValue: () => '#242424'
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
        callbacks.forEach(callback => callback(time));
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
        motion,
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
    assert.equal(chart.findFrameAt(100, 33), 3);
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

test('frame separators belong to the preceding frame without swallowing empty space', () => {
    for (const dpr of [1, 1.5, 2]) {
        const { chart, pointer, scroll, flush } = createChart(1000, 100, dpr);
        const { tree, values } = fixture();
        const enter = vi.fn();
        const leave = vi.fn();

        chart.setData(tree, {
            value: index => values[index],
            childrenSort: true
        });
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
        assert.equal(chart.findFrameAt(999.5, 22), 1);
        assert.equal(chart.findFrameAt(1000, 22), -1);
        assert.equal(chart.findFrameAt(-0.5, 22), -1);

        pointer('click', 599.5, 22, true);
        assert.equal(chart.selectedNode, 3);
        pointer('pointermove', 600, 22);
        assert.equal(enter.mock.calls.at(-1)[0], 1);
        assert.equal(leave.mock.calls.length, 0);
        pointer('pointermove', 500, 39);
        assert.equal(leave.mock.calls.length, 1);

        scroll.scrollTop = 17.25;
        scroll.dispatchEvent(new Event('scroll'));
        flush();

        assert.equal(chart.findFrameAt(599.5, 16.5), 3);
        assert.equal(chart.findFrameAt(100, 16.75), 4);
        chart.destroy();
    }
});

test('animated frame fills take precedence over another frame separator', () => {
    const { chart, canvas, flush } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    chart.setData(tree, { value: index => values[index] });
    flush(0);
    chart.zoomFrame(1);
    canvas.context.fillRect.mockClear();
    flush(65);

    const row = canvas.context.fillRect.mock.calls.filter(([, top]) => top === 17);
    const retained = row.find(([left]) => left === 0);
    const right = retained[0] + retained[2];

    assert.equal(chart.findFrameAt(right - 0.25, 22), 1);
    assert.equal(chart.findFrameAt(right + 0.25, 22), 3, 'Visible departing fill wins over the common frame border');
    assert.equal(chart.findFrameAt(right + 0.25, 33.5), 3);

    canvas.context.fillRect.mockClear();
    flush(15);

    const next = canvas.context.fillRect.mock.calls.find(([left, top]) => left === 0 && top === 17);
    const nextRight = next[0] + next[2];

    assert.equal(chart.findFrameAt(nextRight + 0.25, 22), 1, 'An unpickable faded frame does not block border ownership');
    assert.equal(chart.findFrameAt(nextRight + 1, 22), -1);
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

test('zoom interpolates the displayed viewport while preserving target geometry and picking', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush();
    canvas.context.fillRect.mockClear();
    chart.zoomFrame(1, false, 'continuous');
    flush();

    const row = canvas.context.fillRect.mock.calls.filter(([, top]) => top === 17);

    assert.equal(row.length, 2, 'Both siblings remain visible during the first zoom frame');

    const boundary = row[1][0];

    assert.ok(boundary > 0 && boundary < 600, `Expected an intermediate boundary, got ${boundary}`);
    assert.equal(chart.zoomStart, 0.6);
    assert.equal(chart.zoomEnd, 1);
    assert.equal(chart.findFrameAt(boundary / 2, 22), 3);
    assert.equal(chart.findFrameAt((boundary + 1000) / 2, 22), 1);
    assert.equal(scheduled.size, 1);

    chart.destroy();
    assert.equal(scheduled.size, 0);
});

test('zoom depends on elapsed time rather than frame cadence', () => {
    const snapshots = [];

    for (const intervals of [
        Array(12).fill(1000 / 60),
        Array(24).fill(1000 / 120),
        [5, 30, 15, 100, 50]
    ]) {
        const { chart, canvas, flush } = createChart(1000, 170, 2, false);
        const { tree, values } = fixture();

        chart.setData(tree, {
            value: index => values[index],
            childrenSort: true
        });
        flush(0);
        chart.zoomFrame(1, false, 'continuous');

        for (const elapsed of intervals) {
            canvas.context.fillRect.mockClear();
            flush(elapsed);
        }

        snapshots.push(canvas.context.fillRect.mock.calls.map(rect => rect.slice()));
        chart.destroy();
    }

    for (const snapshot of snapshots.slice(1)) {
        assert.equal(snapshot.length, snapshots[0].length);

        for (let index = 0; index < snapshot.length; index++) {
            for (let coordinate = 0; coordinate < 4; coordinate++) {
                assert.ok(Math.abs(snapshot[index][coordinate] - snapshots[0][index][coordinate]) < 1e-8);
            }
        }
    }
});

test('zoom retargeting starts at the displayed position and settles without resource replacement', () => {
    const { chart, canvas, flush, elements, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const renderRoot = vi.fn();

    chart.on('render', renderRoot);
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush(0);
    chart.zoomFrame(1, false, 'continuous');
    flush(60);
    canvas.context.fillRect.mockClear();
    chart.zoomFrame(1, false, 'continuous');
    flush(60);

    const before = canvas.context.fillRect.mock.calls.map(rect => rect.slice());
    const boundary = before.find(([left, top]) => top === 17 && left > 0)[0];
    const viewStart = 0.6 * (1 - Math.exp(-120 / 65));

    assert.ok(Math.abs(boundary - (0.6 - viewStart) / (1 - viewStart) * 1000) < 1e-8);

    chart.resetZoom();
    canvas.context.fillRect.mockClear();
    flush(0);

    assert.deepEqual(canvas.context.fillRect.mock.calls, before);
    assert.equal(chart.zoomStart, 0);
    assert.equal(chart.zoomEnd, 1);

    let frames = 0;

    while (scheduled.size > 0 && frames < 200) {
        canvas.context.fillRect.mockClear();
        flush();
        frames++;

        const painted = new Map();

        for (const [left, top, width] of canvas.context.fillRect.mock.calls) {
            const node = chart.findFrameAt(left + width / 2, top + 5);

            assert.notEqual(node, -1);
            painted.set(node, { left, right: left + width });

            if (node !== 0) {
                const parent = painted.get(tree.parent[node]);

                assert.ok(parent);
                assert.ok(left >= parent.left - 1e-9);
                assert.ok(left + width <= parent.right + 1e-9);
            }
        }
    }

    assert.ok(frames > 1 && frames < 200);
    assert.equal(scheduled.size, 0);
    assert.equal(chart.findFrameAt(599, 22), 3);
    assert.equal(chart.findFrameAt(600, 22), 1);
    assert.equal(elements.length, 3);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);
    assert.equal(renderRoot.mock.calls.length, 3);

    chart.destroy();
});

test('reduced motion, metric changes and tree replacement do not retain obsolete zoom motion', () => {
    const { chart, canvas, flush, motion, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
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
    chart.resetZoom();
    flush(20);
    values.fill(0);
    chart.resetValues();
    flush();

    assert.equal(chart.findFrameAt(100, 22), -1);

    const replacement = fixture();

    chart.setData(replacement.tree, { value: index => replacement.values[index] });
    flush();

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

test('zoom animation fades actual ancestors, not earlier visible sibling branches', () => {
    const { chart, canvas, flush } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const fills = [];

    chart.setData(tree, { value: index => values[index] });
    flush(0);
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        fills.push({ left, top, width, alpha: canvas.context.globalAlpha });
    });
    chart.zoomFrame(3, false, 'continuous');
    flush(16);

    const root = fills.find(frame => frame.top === 0);
    const sibling = fills.find(frame => frame.top === 17 && frame.left === 0);

    assert.equal(chart.findFrameAt(sibling.width / 2, 22), 1);
    assert.equal(root.alpha, 0.65);
    assert.equal(sibling.alpha, 1);

    chart.destroy();
});

test('geometry inspection does not consume motion invalidation after a metric update', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();

    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush(0);
    chart.zoomFrame(1);
    flush(20);

    canvas.context.fillRect.mockClear();
    chart.render();

    const before = canvas.context.fillRect.mock.calls.map(rect => rect.slice());

    values[1] = 20;
    values[2] = 10;
    values[3] = 80;
    chart.resetValues();
    chart.getVisibleFrames();
    canvas.context.fillRect.mockClear();
    flush(0);

    assert.equal(chart.zoomStart, 0.8);
    assert.deepEqual(canvas.context.fillRect.mock.calls, before);

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        flush();
    }

    assert.equal(scheduled.size, 0);
    assert.equal(chart.findFrameAt(100, 22), 1);

    chart.destroy();
});

test('picked zoom moves common frames promptly and quickly fades departing frames in place', () => {
    const { chart, canvas, pointer, flush } = createChart(1000, 170, 1, false);
    const tree = new CallTree(
        [{ name: 'root' }, { name: 'small' }, { name: 'rest' }],
        new Uint32Array([0, 1, 2]),
        new Uint32Array([0, 0, 0]),
        new Uint32Array([2, 0, 0])
    );
    const values = [1000, 1, 999];
    const fills = [];

    chart.setData(tree, { value: index => values[index] });
    flush(0);
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        if (top === 17) {
            fills.push({ left, width, alpha: canvas.context.globalAlpha });
        }
    });
    pointer('click', 0.5, 22);
    flush(65);

    const retained = fills.find(frame => frame.left === 0);
    const departing = fills.find(frame => frame.left === 1);

    assert.ok(retained.width > 600 && retained.width < 700, `Expected prompt expansion, got ${retained.width}`);
    assert.ok(departing, 'Departing frame stays at its original position');
    assert.equal(departing.width, 998);
    assert.ok(departing.alpha > 0 && departing.alpha < 0.05);
    assert.equal(chart.findFrameAt(400, 22), 1);
    assert.equal(chart.findFrameAt(900, 22), 2);

    chart.destroy();
});

test('picked zoom out reveals new frames over the tail of retained movement', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const fills = [];

    chart.setData(tree, { value: index => values[index] });
    flush(0);
    chart.zoomFrame(1);

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        flush();
    }

    canvas.context.fillRect.mockImplementation((left, top, width) => {
        if (top === 17) {
            fills.push({ left, width, alpha: canvas.context.globalAlpha });
        }
    });
    chart.resetZoom();
    flush(65);

    const retained = fills.find(frame => frame.left === 0);

    assert.equal(fills.find(frame => frame.left === 400), undefined);
    assert.ok(retained.width > 600 && retained.width < 650);
    assert.equal(chart.findFrameAt(500, 22), 1);
    assert.equal(chart.findFrameAt(900, 22), -1);

    let arriving;
    let revealTime = 65;

    for (let frame = 0; frame < 120; frame++) {
        fills.length = 0;
        flush();
        revealTime += 1000 / 60;
        arriving = fills.find(item => item.left === 400);

        if (arriving) {
            const width = fills.find(item => item.left === 0).width;

            assert.ok(width > 399 && width <= 414, `Expected late residual movement at reveal, got ${width}`);
            break;
        }

        assert.equal(chart.findFrameAt(900, 22), -1);
    }

    assert.ok(arriving, 'New frames eventually fade in');
    assert.ok(revealTime >= 65 * Math.log(600) * 0.6);
    assert.ok(revealTime <= 65 * Math.log(600) * 0.6 + 1000 / 60, 'Reveal follows the accepted delay factor');
    assert.equal(arriving.width, 599);
    assert.ok(arriving.alpha > 0 && arriving.alpha < 1);

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        flush();
    }

    assert.equal(scheduled.size, 0);
    assert.equal(chart.findFrameAt(900, 22), 3);

    chart.destroy();
});

test('picked readable reveal uses elapsed time independently of frame cadence', () => {
    const snapshots = [];

    for (const intervals of [Array(24).fill(1000 / 60), Array(48).fill(1000 / 120), [100, 200, 100], [400]]) {
        const { chart, canvas, flush } = createChart(1000, 170, 1, false);
        const { tree, values } = fixture();
        const fills = [];

        chart.setData(tree, { value: index => values[index] });
        flush(0);
        chart.zoomFrame(1);
        flush(2000);
        canvas.context.fillRect.mockImplementation((left, top, width) => {
            if (top === 17) {
                fills.push([left, width, canvas.context.globalAlpha]);
            }
        });
        chart.resetZoom();

        for (const elapsed of intervals) {
            fills.length = 0;
            flush(elapsed);
        }

        const arriving = fills.find(([left]) => left === 400);

        const width = fills.find(([left]) => left === 0)[1];

        assert.ok(width >= 399 && width < 401);
        assert.ok(arriving, 'New frames gradually appear near their final geometry');
        assert.ok(arriving[2] > 0.1 && arriving[2] < 0.9);
        snapshots.push(fills.map(frame => frame.slice()));
        chart.destroy();
    }

    for (const snapshot of snapshots.slice(1)) {
        assert.equal(snapshot.length, snapshots[0].length);

        for (let index = 0; index < snapshot.length; index++) {
            for (let coordinate = 0; coordinate < 3; coordinate++) {
                assert.ok(Math.abs(snapshot[index][coordinate] - snapshots[0][index][coordinate]) < 1e-8);
            }
        }
    }
});

test('picked reveal can be interrupted before and after arrival without an opacity jump', () => {
    for (const elapsed of [100, 550]) {
        const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
        const { tree, values } = fixture();
        const fills = [];

        chart.setData(tree, { value: index => values[index] });
        flush(0);
        chart.zoomFrame(1);
        flush(2000);
        canvas.context.fillRect.mockImplementation((left, top, width) => {
            if (top === 17) {
                fills.push([left, width, canvas.context.globalAlpha]);
            }
        });
        chart.resetZoom();
        flush(elapsed);

        const before = fills.map(frame => frame.slice()).sort((left, right) => left[0] - right[0]);

        chart.zoomFrame(1);
        fills.length = 0;
        flush(0);

        assert.deepEqual(fills.sort((left, right) => left[0] - right[0]), before);

        for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
            fills.length = 0;
            flush();
        }

        assert.equal(scheduled.size, 0);
        assert.deepEqual(fills, [[0, 999, 1]]);
        assert.equal(chart.findFrameAt(900, 22), 1);

        chart.destroy();
    }
});

test('picked zoom is cadence-independent and retargets current geometry and opacity', () => {
    const snapshots = [];

    for (const steps of [6, 12]) {
        const { chart, canvas, flush, scheduled, elements } = createChart(1000, 170, 2, false);
        const { tree, values } = fixture();
        const fills = [];

        chart.setData(tree, { value: index => values[index] });
        flush(0);
        canvas.context.fillRect.mockImplementation((left, top, width, height) => {
            fills.push([left, top, width, height, canvas.context.globalAlpha]);
        });
        chart.zoomFrame(1);

        for (let step = 0; step < steps; step++) {
            fills.length = 0;
            flush(100 / steps);
        }

        snapshots.push(fills.map(rect => rect.slice()));

        const before = fills.filter(([, top]) => top === 17).sort((left, right) => left[0] - right[0]);

        chart.resetZoom();
        fills.length = 0;
        flush(0);

        assert.deepEqual(fills.filter(([, top]) => top === 17).sort((left, right) => left[0] - right[0]), before);

        for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
            flush();
        }

        assert.equal(scheduled.size, 0);
        assert.equal(chart.findFrameAt(100, 22), 1);
        assert.equal(chart.findFrameAt(500, 22), 3);
        assert.equal(elements.length, 3);

        chart.destroy();
    }

    assert.equal(snapshots[0].length, snapshots[1].length);

    for (let index = 0; index < snapshots[0].length; index++) {
        for (let coordinate = 0; coordinate < 5; coordinate++) {
            assert.ok(Math.abs(snapshots[0][index][coordinate] - snapshots[1][index][coordinate]) < 1e-8);
        }
    }
});

test('picked deep zoom settles overlapping motion and reveal without restarting for the same target', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const tree = new CallTree(
        [{ name: 'root' }, { name: 'small' }, { name: 'rest' }],
        new Uint32Array([0, 1, 2]),
        new Uint32Array([0, 0, 0]),
        new Uint32Array([2, 0, 0])
    );
    const values = [1000, 1, 999];
    const frameCounts = [];

    chart.setData(tree, { value: index => values[index] });
    flush(0);

    for (const node of [1, 0]) {
        let frames = 0;

        chart.zoomFrame(node);

        while (scheduled.size > 0 && frames < 120) {
            canvas.context.fillRect.mockClear();
            chart.zoomFrame(node);
            flush();
            frames++;
        }

        assert.ok(frames < 50, `Deep picked zoom took ${frames} frames`);
        assert.equal(scheduled.size, 0);
        frameCounts.push(frames);
    }

    assert.ok(frameCounts[1] - frameCounts[0] <= 15, 'Reveal has a finite tail rather than another exponential settling period');
    assert.equal(chart.findFrameAt(0.5, 22), 1);
    assert.equal(chart.findFrameAt(900, 22), 2);

    chart.destroy();
});

test('picked transitions keep own-parent bounds during retargeting and vertical scrolling', () => {
    const { chart, canvas, flush, scroll, scheduled } = createChart(1000, 51, 2, false);
    const tree = new CallTree(
        Array.from({ length: 5 }, (_, index) => ({ name: `Frame ${index}`, index })),
        new Uint32Array([0, 1, 2, 3, 4]),
        new Uint32Array([0, 0, 1, 0, 3]),
        new Uint32Array([4, 1, 0, 1, 0])
    );
    const values = [100, 40, 20, 60, 30];
    const painted = new Map();

    chart.colorMapper = entry => `${entry.index}, 0, 0`;
    chart.setData(tree, { value: index => values[index] });
    flush(0);
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        const node = Number(canvas.context.fillStyle.match(/rgb\((\d+),/)[1]);

        assert.equal(chart.nodesDepth[node], Math.round((top + scroll.scrollTop) / 17));
        painted.set(node, { left, right: left + width });

        if (node !== 0 && top >= 17) {
            const parent = painted.get(tree.parent[node]);

            assert.ok(parent);
            assert.ok(left >= parent.left - 1e-8);
            assert.ok(left + width <= parent.right + 1e-8);
        }
    });

    for (const node of [1, 3, 0]) {
        chart.zoomFrame(node);

        for (let frame = 0; frame < 6; frame++) {
            painted.clear();
            flush();
        }

        scroll.scrollTop = scroll.scrollTop === 0 ? 17 : 0;
        scroll.dispatchEvent(new Event('scroll'));
        painted.clear();
        flush();
    }

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        painted.clear();
        flush();
    }

    assert.equal(scheduled.size, 0);
    chart.destroy();
});

test('new zoom-in descendants reveal at destination bounds clipped by their moving parent', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const tree = new CallTree(
        Array.from({ length: 5 }, (_, index) => ({ name: `Frame ${index}`, index })),
        new Uint32Array([0, 1, 2, 3, 4]),
        new Uint32Array([0, 0, 1, 1, 0]),
        new Uint32Array([4, 2, 0, 0, 0])
    );
    const values = [1000, 10, 9, 1, 990];
    const arrivals = [];

    chart.colorMapper = entry => `${entry.index}, 0, 0`;
    chart.setData(tree, { value: index => values[index] });
    flush(0);
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        if (canvas.context.fillStyle.includes('rgb(3,')) {
            arrivals.push({ left, width, alpha: canvas.context.globalAlpha });
        }
    });
    chart.zoomFrame(1);

    for (let frame = 0; scheduled.size > 0 && frame < 180; frame++) {
        flush(1000 / 60);
    }

    assert.equal(scheduled.size, 0);
    assert.ok(arrivals.length > 0);

    for (const frame of arrivals) {
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
        const { chart, canvas, scroll, flush } = createChart(1000, 100, 1, false);
        const { tree, values } = fixture();
        const fills = [];

        chart.setData(tree, { value: index => values[index] });
        flush(0);
        chart.zoomFrame(1);
        flush(2000);
        canvas.context.fillRect.mockImplementation((left, top, width) => {
            if (top + scroll.scrollTop === 17) {
                fills.push([left, width, canvas.context.globalAlpha]);
            }
        });
        chart.resetZoom();
        flush(550);

        if (scrollDuringReveal) {
            scroll.scrollTop = 1;
            scroll.dispatchEvent(new Event('scroll'));
        }

        flush(0);
        fills.length = 0;
        flush(30);
        snapshots.push(fills.find(([left]) => left === 400));
        chart.destroy();
    }

    assert.deepEqual(snapshots[1], snapshots[0]);
});

test('scrolling reveals existing rows immediately even during zoom or metric motion', () => {
    for (const update of ['none', 'zoom', 'metrics']) {
        const { chart, canvas, scroll, flush, scheduled } = createChart(1000, 51, 1, false);
        const count = 12;
        const tree = new CallTree(
            Array.from({ length: count }, (_, index) => ({ name: `Frame ${index}` })),
            Uint32Array.from({ length: count }, (_, index) => index),
            Uint32Array.from({ length: count }, (_, index) => index === count - 1 ? 0 : Math.max(0, index - 1)),
            Uint32Array.from({ length: count }, (_, index) => index === 0 ? count - 1 : Math.max(0, count - index - 2))
        );
        const values = Array.from({ length: count }, (_, index) => index === 0 ? 100 : index === count - 1 ? 60 : 40);
        const fills = [];

        chart.setData(tree, { value: index => values[index] });
        flush(0);

        if (update === 'zoom') {
            chart.zoomFrame(1);
            flush(20);
        } else if (update === 'metrics') {
            values[1] = 50;
            values[count - 1] = 50;
            chart.resetValues();
            flush(0);
            flush(20);
        }

        canvas.context.fillRect.mockImplementation((left, top, width) => {
            if (top + 16 > 0 && top < 51) {
                fills.push({ left, top, width, alpha: canvas.context.globalAlpha });
            }
        });
        scroll.scrollTop = 5 * 17;
        scroll.dispatchEvent(new Event('scroll'));
        flush(0);

        assert.equal(fills.length, 3, `${update}: entering rows are drawn on the scroll frame`);
        assert.ok(fills.every(frame => frame.alpha === 1), `${update}: scrolling does not introduce fade-in`);
        assert.equal(chart.findFrameAt(100, 5), 5);
        assert.equal(chart.findFrameAt(100, 22), 6);
        assert.equal(chart.findFrameAt(100, 39), 7);

        for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
            flush();
        }

        assert.equal(scheduled.size, 0);
        chart.destroy();
    }
});

test('metric reordering moves stable tree nodes from their displayed geometry', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const tree = new CallTree(
        Array.from({ length: 5 }, (_, index) => ({ name: `Frame ${index}`, index })),
        new Uint32Array([0, 1, 2, 3, 4]),
        new Uint32Array([0, 0, 1, 0, 3]),
        new Uint32Array([4, 1, 0, 1, 0])
    );
    const values = [100, 40, 20, 60, 30];
    const painted = new Map();

    chart.colorMapper = entry => `${entry.index}, 0, 0`;
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        const node = Number(canvas.context.fillStyle.match(/rgb\((\d+),/)[1]);

        painted.set(node, [left, top, width]);
    });
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush(0);

    const before = new Map(painted);

    values.splice(0, values.length, 200, 140, 70, 60, 30);
    chart.resetValues();
    painted.clear();
    flush(0);

    assert.equal(chart.nodesValue[0], 200);
    assert.deepEqual(painted.get(1), before.get(1));
    assert.deepEqual(painted.get(3), before.get(3));

    painted.clear();
    flush(65);

    assert.ok(painted.get(1)[0] > 0 && painted.get(1)[0] < 600);
    assert.ok(painted.get(3)[0] > 0 && painted.get(3)[0] < 700);

    for (const node of [2, 4]) {
        const child = painted.get(node);
        const parent = painted.get(tree.parent[node]);

        assert.ok(child[0] >= parent[0] - 1e-8);
        assert.ok(child[0] + child[2] <= parent[0] + parent[2] + 1e-8);
    }

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        painted.clear();
        flush();
    }

    assert.equal(scheduled.size, 0);
    assert.deepEqual(painted.get(1), [0, 17, 699]);
    assert.deepEqual(painted.get(3), [700, 17, 299]);
    assert.equal(chart.findFrameAt(100, 22), 1);
    assert.equal(chart.findFrameAt(800, 22), 3);
    chart.destroy();
});

test('metric animation retargets mid-reorder while keeping parent identity and painted hit order', () => {
    const { chart, canvas, flush, scheduled, elements } = createChart(1000, 170, 2, false);
    const tree = new CallTree(
        Array.from({ length: 5 }, (_, index) => ({ name: `Frame ${index}`, index })),
        new Uint32Array([0, 1, 2, 3, 4]),
        new Uint32Array([0, 0, 1, 0, 3]),
        new Uint32Array([4, 1, 0, 1, 0])
    );
    const values = [100, 40, 20, 60, 30];
    const fills = [];
    const renderRoot = vi.fn();

    chart.colorMapper = entry => `${entry.index}, 0, 0`;
    chart.on('render', renderRoot);
    canvas.context.fillRect.mockImplementation((left, top, width) => {
        const node = Number(canvas.context.fillStyle.match(/rgb\((\d+),/)[1]);

        fills.push({ node, left, top, right: left + width, alpha: canvas.context.globalAlpha });
    });
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
    flush(0);

    values.splice(0, values.length, 200, 140, 70, 60, 30);
    chart.resetValues();
    flush(0);
    fills.length = 0;
    flush(40);

    const before = fills.slice().sort((left, right) => left.node - right.node);

    values.splice(0, values.length, 100, 30, 15, 70, 35);
    chart.resetValues();
    fills.length = 0;
    flush(0);

    assert.deepEqual(fills.slice().sort((left, right) => left.node - right.node), before);

    for (let frame = 0; scheduled.size > 0 && frame < 120; frame++) {
        fills.length = 0;
        flush();

        for (const child of fills.filter(item => item.node !== 0)) {
            const parent = fills.find(item => item.node === tree.parent[child.node]);

            assert.ok(parent);
            assert.ok(child.left >= parent.left - 1e-8);
            assert.ok(child.right <= parent.right + 1e-8);
        }

        for (const top of [17, 34]) {
            for (let position = 0.5; position < 1000; position += 37) {
                const painted = fills.findLast(item => item.top === top &&
                    item.alpha > 0.01 && position >= item.left && position < item.right
                );
                const border = fills.findLast(item => item.top === top &&
                    item.alpha > 0.01 && position >= item.left && position < item.right + 1
                );

                assert.equal(chart.findFrameAt(position, top + 5), painted?.node ?? border?.node ?? -1);
            }
        }
    }

    assert.equal(scheduled.size, 0);
    assert.equal(elements.length, 3);
    assert.equal(canvas.context.setTransform.mock.calls.length, 1);
    assert.equal(renderRoot.mock.calls.length, 3);
    assert.equal(renderRoot.mock.calls.at(-1)[2], 100);
    chart.destroy();
});

test('metric animation handles disappearing zoom nodes, zero data and later reappearance', () => {
    const { chart, canvas, flush, scheduled } = createChart(1000, 170, 1, false);
    const { tree, values } = fixture();
    const zoom = vi.fn();

    chart.on('zoom', zoom);
    chart.setData(tree, {
        value: index => values[index],
        childrenSort: true
    });
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
