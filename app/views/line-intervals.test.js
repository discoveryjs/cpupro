import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { createElement } from '../../test/helpers/dom.js';

// A line over the range from 100 to 200
async function createLine() {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });

    return line;
}

function render(config, data, context, renders = []) {
    let renderIntervals;
    let lifecycle;

    evaluateModule(new URL('./line-intervals.js', import.meta.url), {
        resolveScopeProfileLine,
        resolveScopeViewport,
        lineZoom,
        subscribeLineZoom,
        utils: { createElement },
        discovery: { view: { define: (_, callback) => renderIntervals = callback } },
        HTMLElement: class {},
        customElements: { define: (name, Element) => lifecycle = { name, Element } }
    });

    const el = createElement('div');
    const host = {
        render(...args) {
            renders.push(args);
            return Promise.resolve(args[2]);
        }
    };
    const result = renderIntervals.call(host, el, config, data, context);

    assert.equal(lifecycle.name, 'destroy-line-intervals');

    return { el, result, LifecycleElement: lifecycle.Element };
}

const styles = el => el.children
    .filter(child => child.className === 'interval')
    .map(child => Object.fromEntries(child.styles));

test('places intervals overlapping the range as fractions of it', async () => {
    const line = await createLine();
    const intervals = [
        { start: 80, end: 100, color: 'a' },
        { start: 90, end: 110, color: 'b' },
        { start: 150, end: 175, color: 'c' },
        { start: 190, end: 250, color: 'd' },
        { start: 200, end: 210, color: 'e' }
    ];
    const { el } = render({}, intervals, { scopeLine: line, scopeViewport: { start: 100, end: 200 } });

    assert.equal(el.children.length, 3);
    assert.deepEqual(styles(el), [
        { '--start': -0.1, '--end': 0.1, '--color': 'b' },
        { '--start': 0.5, '--end': 0.75, '--color': 'c' },
        { '--start': 0.9, '--end': 1.5, '--color': 'd' }
    ]);
    assert.deepEqual(render({}, null, { scopeLine: line }).el.children, []);
});

test('zoom displays the line zoom within the range until destroyed', async () => {
    const line = await createLine();
    const context = { scopeLine: line, scopeViewport: { start: 100, end: 200 } };
    const { el } = render({ zoom: true }, [{ start: 150, end: 160, color: 'a' }], context);
    const destroyEl = el.children.at(-1);
    const display = () => Object.fromEntries(el.styles);

    assert.equal(destroyEl.tagName, 'destroy-line-intervals');
    line.zoom.selection.setRange(120, 145);
    assert.equal(el.styles.size, 0);

    destroyEl.onConnect();
    assert.deepEqual(display(), { '--display-start': 0.2, '--display-scale': 4 });
    line.zoom.resetRange();
    assert.deepEqual(display(), { '--display-start': 0, '--display-scale': 1 });

    // Without a zoom request the viewport is displayed
    line.viewport.selection.setRange(150, 200);
    assert.deepEqual(display(), { '--display-start': 0.5, '--display-scale': 2 });
    line.viewport.resetRange();

    destroyEl.onDestroy();
    line.zoom.selection.setRange(120, 145);
    assert.deepEqual(display(), { '--display-start': 0, '--display-scale': 1 });
    line.zoom.resetRange();
});

test('renders an item config into each interval and leaves the band uncolored without a color', async () => {
    const line = await createLine();
    const itemConfig = { view: 'block' };
    const intervals = [
        { start: 110, end: 120 },
        { start: 300, end: 310 },
        { start: 150, end: 160, color: 'x' }
    ];
    const context = { scopeLine: line, scopeViewport: { start: 100, end: 200 } };
    const renders = [];
    const { el, result } = render({ itemConfig }, intervals, context, renders);
    const bands = el.children.filter(child => child.className === 'interval');

    assert.deepEqual(renders, [
        [bands[0], itemConfig, intervals[0], context],
        [bands[1], itemConfig, intervals[2], context]
    ]);
    assert.deepEqual([...await result], [intervals[0], intervals[2]]);
    assert.equal(bands[0].styles.has('--color'), false);
    assert.equal(bands[1].styles.get('--color'), 'x');
});

test('bands without an item config render nothing into them', async () => {
    const line = await createLine();
    const renders = [];
    const context = { scopeLine: line, scopeViewport: { start: 100, end: 200 } };
    const { result } = render({}, [{ start: 110, end: 120 }], context, renders);

    assert.deepEqual(renders, []);
    assert.deepEqual([...await result], []);
});

test('the destroy element calls its connect and destroy hooks once', () => {
    const { LifecycleElement } = render({}, [], { scopeViewport: { start: 100, end: 200 } });
    const element = new LifecycleElement();
    const calls = [];

    element.onConnect = () => calls.push('connect');
    element.onDestroy = () => calls.push('destroy');
    element.connectedCallback();
    element.disconnectedCallback();

    assert.deepEqual(calls, ['connect', 'destroy']);
    assert.equal(element.onConnect, null);
    assert.equal(element.onDestroy, null);
});
