import assert from 'node:assert/strict';
import { test } from 'vitest';
import { lineViewport, lineViewportBounds, lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function createElement(tagName, className = '') {
    const element = {
        tagName, className, children: [], hidden: false, listeners: new Map(),
        classList: { add: name => element.className += ' ' + name, contains: name => element.className.split(' ').includes(name) },
        style: { values: new Map(), setProperty: (name, value) => element.style.values.set(name, value) },
        append: (...children) => element.children.push(...children),
        replaceChildren: (...children) => element.children = children,
        addEventListener: (name, callback) => element.listeners.set(name, callback)
    };

    return element;
}

async function render() {
    const first = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const second = await createLineFixture({ origin: 150, values: new Uint32Array([100]) });
    const profiles = [{ profile: first.profile }, { profile: second.profile }];
    const context = { primaryProfile: first.profile, data: { profiles: [first.profile, second.profile] } };
    const renders = [];
    let renderView;

    evaluateModule(new URL('./timeline-profiles.js', import.meta.url), {
        utils: { createElement },
        lineZoom, subscribeLineZoom, lineViewport,
        lineViewportBounds,
        document: { createElement },
        discovery: {
            view: { define: (_, callback) => renderView = callback },
            query: query => query.includes('group(') ? profiles : query.includes('axisStart') ? 100 : 250,
            action: { call() {} }
        }
    });

    const el = createElement('div');

    renderView.call({
        tooltip() {},
        render: (target, config, data, scope) => renders.push({ target, config, data, scope })
    }, el, {}, profiles, context);

    const [primaryBar] = el.children.filter(child => child.className.includes('profile'));
    const ruler = renders.find(render => render.config.view === 'ruler');

    return { el, line: first.profile.timeline, primaryBar, ruler, profiles: context.data.profiles };
}

test('the viewport of the primary timeline and the zoom within it are shown over all profiles, the viewport is changed on the primary profile', async () => {
    const { el, line, primaryBar, ruler, profiles } = await render();
    const window = el.children.find(child => child.className === 'viewport-window');
    const zoom = el.children.find(child => child.className === 'zoom-window');
    const { onInit, onChange } = ruler.config;

    assert.equal(ruler.target, primaryBar);
    assert.ok(primaryBar.className.includes('selected'));
    assert.deepEqual({ ...ruler.config.range }, { start: 100, end: 250 });
    assert.equal(ruler.config.selection, null);
    assert.equal(window.hidden, true);
    assert.equal(zoom.hidden, true);

    const selections = [];
    const api = { state: { selection: null }, setSelection: selection => selections.push(selection) };
    const cleanup = onInit(api);

    // The viewport is followed by the window and the ruler selection
    line.viewport.selection.setRange(130, 160);
    assert.equal(window.hidden, false);
    assert.deepEqual([window.style.values.get('--x1'), window.style.values.get('--x2')], [0.2, 0.4]);
    assert.deepEqual(selections, [{ start: 130, end: 160 }]);

    // The zoom is shown within the viewport, it doesn't change the ruler selection
    line.zoom.selection.setRange(145, 160);
    assert.equal(zoom.hidden, false);
    assert.deepEqual([zoom.style.values.get('--x1'), zoom.style.values.get('--x2')], [0.3, 0.4]);
    assert.deepEqual(selections, [{ start: 130, end: 160 }, { start: 130, end: 160 }]);

    // The ruler selection requests the viewport without echoing it back; the whole bounds and none reset it
    api.state.selection = { start: 175, end: 205 };
    onChange(api);
    assert.deepEqual(line.viewport.selection.ranges, [{ start: 175, end: 205 }]);
    assert.equal(zoom.hidden, true);
    assert.deepEqual([window.style.values.get('--x1'), window.style.values.get('--x2')], [0.5, 0.7]);
    assert.equal(selections.length, 2);
    api.state.selection = lineViewportBounds(line, profiles);
    onChange(api);
    assert.equal(line.viewport.selection.ranges, null);
    assert.equal(window.hidden, true);
    api.state.selection = { start: 100, end: 200 };
    onChange(api);
    assert.deepEqual(line.viewport.selection.ranges, [{ start: 100, end: 200 }]);
    api.state.selection = null;
    onChange(api);
    assert.equal(line.viewport.selection.ranges, null);

    cleanup();
    line.viewport.selection.setRange(130, 160);
    line.zoom.selection.setRange(140, 150);
    assert.equal(window.hidden, true);
    assert.equal(zoom.hidden, true);
    assert.equal(selections.length, 2);
    line.viewport.resetRange();
});

test('selected ranges of the primary timeline are shown over all profiles', async () => {
    const { el, line, ruler } = await render();
    const selectionsEl = el.children.find(child => child.className === 'selections');
    const api = { state: { selection: null }, setSelection() {} };

    assert.deepEqual(selectionsEl.children, []);
    const cleanup = ruler.config.onInit(api);

    line.range.selection.setRanges([{ start: 115, end: 130 }, { start: 220, end: 250 }]);
    assert.deepEqual(selectionsEl.children.map(child => [child.style.values.get('--x1'), child.style.values.get('--x2')]), [[0.1, 0.2], [0.8, 1]]);
    line.range.selection.resetRange();
    assert.deepEqual(selectionsEl.children, []);
    cleanup();
    line.range.selection.setRange(115, 130);
    assert.deepEqual(selectionsEl.children, []);
    line.range.selection.resetRange();
});
