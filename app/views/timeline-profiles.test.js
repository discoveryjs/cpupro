import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { lineViewport, lineViewportBounds, lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function createElement(tagName, className = '') {
    const element = {
        tagName,
        className,
        children: [],
        hidden: false,
        listeners: new Map(),
        textContent: '',
        classList: { add: name => element.className += ' ' + name, contains: name => element.className.split(' ').includes(name) },
        style: { values: new Map(), setProperty: (name, value) => element.style.values.set(name, value) },
        append: (...children) => element.children.push(...children),
        replaceChildren: (...children) => element.children = children,
        addEventListener: (name, callback) => element.listeners.set(name, callback)
    };

    return element;
}

const position = element => [element.style.values.get('--x1'), element.style.values.get('--x2')];

// Two profiles over 100–200 and 150–250; the bucket query gives the profiles as they are passed
async function render(options = {}) {
    const props = options.props ?? {};
    const primary = options.primary ?? 0;
    const viaProps = options.viaProps ?? false;
    const name = options.name;
    const selection = options.selection ?? null;
    const first = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const second = await createLineFixture({ origin: 150, values: new Uint32Array([100]) });

    first.profile.name = name;
    first.profile.timeline.range.selection.setRanges(selection);
    const profiles = [{ profile: first.profile }, { profile: second.profile }];
    const context = {
        primaryProfile: profiles[primary]?.profile ?? null,
        data: { profiles: [first.profile, second.profile] }
    };
    const renders = [];
    const tooltips = [];
    const actions = [];
    const query = (text, data) => text.includes('group(') ? data : text.includes('axisStart') ? 100 : 250;
    let renderView;

    evaluateModule(new URL('./timeline-profiles.js', import.meta.url), {
        utils: { createElement },
        lineZoom, subscribeLineZoom, lineViewport,
        lineViewportBounds,
        document: { createElement },
        discovery: {
            view: { define: (_, callback) => renderView = callback },
            query,
            action: { call: (name, profile) => actions.push([name, profile]) }
        }
    });

    const el = createElement('div');
    const viewProps = viaProps ? { ...props, profiles } : props;
    const viewData = viaProps ? [] : profiles;

    renderView.call({
        tooltip: (target, config, data) => tooltips.push([target, data]),
        render: (target, config, data, scope) => renders.push({ target, config, data, scope })
    }, el, viewProps, viewData, context);

    const bars = el.children.filter(child => child.className.startsWith('profile'));
    const buttons = el.children.filter(child => child.tagName === 'button');
    const ruler = renders.find(render => render.config.view === 'ruler');
    const histograms = renders.filter(render => render.config.view === 'bins-histogram');

    return {
        el,
        line: first.profile.timeline,
        profiles,
        bars,
        buttons,
        ruler,
        histograms,
        tooltips,
        actions
    };
}

test.each([
    {
        name: 'profiles of the data',
        options: {},
        range: 150,
        positions: [[0, 100 / 150], [50 / 150, 1]]
    },
    {
        name: 'profiles of the props',
        options: { viaProps: true },
        range: 150,
        positions: [[0, 100 / 150], [50 / 150, 1]]
    },
    {
        name: 'a range from zero',
        options: { props: { startTime: 0, endTime: 300 } },
        range: 300,
        positions: [[100 / 300, 200 / 300], [150 / 300, 250 / 300]]
    }
])('bars of $name are placed in the range of the bucket', async row => {
    const { el, bars } = await render(row.options);

    assert.equal(el.style.values.get('--range'), row.range);
    assert.deepEqual(bars.map(position), row.positions);
});

test('bars hold a caption and a viewport, have a profile tooltip, the primary bar is selected', async () => {
    const { bars, profiles, tooltips } = await render({ primary: 1 });
    const { bars: namedBars } = await render({ name: 'Main' });
    const describeChildren = bar => bar.children.map(child => [child.className, child.textContent]);

    assert.deepEqual(bars.map(bar => bar.className), ['profile', 'profile selected']);
    assert.deepEqual(bars.map(describeChildren), [
        [['caption', '(unnamed profile)'], ['viewport', '']],
        [['caption', '(unnamed profile)'], ['viewport', '']]
    ]);
    assert.equal(namedBars[0].children[0].textContent, 'Main');
    assert.deepEqual(tooltips, [[bars[0], profiles[0].profile], [bars[1], profiles[1].profile]]);
});

test('a button toggles its profile, a click on a bar other than the primary selects its profile', async () => {
    const { bars, buttons, profiles, actions } = await render();

    buttons[0].listeners.get('click')();
    buttons[1].listeners.get('click')();
    bars[1].listeners.get('click')();

    assert.equal(bars[0].listeners.has('click'), false);
    assert.deepEqual(actions, [
        ['toggleProfile', profiles[0].profile],
        ['toggleProfile', profiles[1].profile],
        ['selectProfile', profiles[1].profile]
    ]);
});

test('histograms of the profiles are placed in the time range of all profiles', async () => {
    const { histograms } = await render();
    const query = jora.setup({ methods });

    // Profiles of 100–200 and 150–250 take the first two thirds and the last two thirds of the range, to a bin
    const measurePlacement = histogram => {
        const { skip, total, bins } = query(histogram.config.data)(histogram.data, {});
        let first = -1;
        let last = -1;

        for (let i = 0; i < bins.length; i++) {
            if (bins[i] > 0) {
                if (first === -1) {
                    first = i;
                }

                last = i;
            }
        }

        return { skip, total, span: [first / bins.length, (last + 1) / bins.length] };
    };
    const placements = histograms.map(measurePlacement);

    assert.deepEqual(placements.map(placement => [placement.skip, placement.total]), [[0, 150], [50, 150]]);
    assert.equal(placements[0].span[0], 0);
    assert.ok(Math.abs(placements[0].span[1] - 2 / 3) < 0.01);
    assert.ok(Math.abs(placements[1].span[0] - 1 / 3) < 0.01);
    assert.equal(placements[1].span[1], 1);
});

test.each([
    { name: 'without the primary profile among the profiles', options: { primary: 2 } },
    { name: 'for an empty range', options: { props: { startTime: 100, endTime: 100 } } }
])('no viewport ruler is shown $name', async row => {
    const { el, ruler } = await render(row.options);

    assert.equal(ruler, undefined);
    assert.equal(el.children.some(child => child.className === 'viewport-window'), false);
});

test('the ruler of the primary bar starts over the whole range without a viewport', async () => {
    const { el, bars, ruler } = await render();
    const windows = el.children.filter(child => child.className.endsWith('-window'));
    const windowStates = windows.map(window => [window.className, window.hidden]);

    assert.equal(ruler.target, bars[0]);
    assert.deepEqual({ ...ruler.config.range }, { start: 100, end: 250 });
    assert.equal(ruler.config.selection, null);
    assert.deepEqual(windowStates, [['viewport-window', true], ['zoom-window', true]]);
});

test('the viewport and the zoom within it are followed by their windows, the viewport by the ruler selection', async () => {
    const { el, line, ruler } = await render();
    const viewportWindow = el.children.find(child => child.className === 'viewport-window');
    const zoomWindow = el.children.find(child => child.className === 'zoom-window');
    const selections = [];
    const api = { state: { selection: null }, setSelection: selection => selections.push(selection) };
    const cleanup = ruler.config.onInit(api);

    line.viewport.selection.setRange(130, 160);
    assert.deepEqual([viewportWindow.hidden, ...position(viewportWindow)], [false, 0.2, 0.4]);

    line.zoom.selection.setRange(145, 160);
    assert.deepEqual([zoomWindow.hidden, ...position(zoomWindow)], [false, 0.3, 0.4]);
    // The zoom within the viewport keeps the ruler selection
    assert.deepEqual(selections, [{ start: 130, end: 160 }, { start: 130, end: 160 }]);

    // A viewport requested by the ruler isn't echoed back, later changes are followed again
    api.state.selection = { start: 175, end: 205 };
    ruler.config.onChange(api);
    assert.equal(selections.length, 2);
    line.viewport.selection.setRange(100, 130);
    assert.deepEqual(selections.at(-1), { start: 100, end: 130 });

    cleanup();
    line.viewport.selection.setRange(130, 160);
    line.zoom.selection.setRange(140, 150);
    assert.equal(selections.length, 3);
    assert.deepEqual(position(viewportWindow), [0, 0.2]);
    line.viewport.resetRange();
});

test.each([
    {
        name: 'a range within the bounds',
        selection: { start: 175, end: 205 },
        ranges: [{ start: 175, end: 205 }],
        hidden: false
    },
    {
        name: 'the whole bounds',
        selection: { start: 100, end: 250 },
        ranges: null,
        hidden: true
    },
    {
        name: 'a range over the bounds',
        selection: { start: 90, end: 260 },
        ranges: null,
        hidden: true
    },
    {
        name: 'a range of a profile',
        selection: { start: 100, end: 200 },
        ranges: [{ start: 100, end: 200 }],
        hidden: false
    },
    {
        name: 'no selection',
        selection: null,
        ranges: null,
        hidden: true
    }
])('the ruler selection of $name requests the viewport of the primary timeline', async row => {
    const { el, line, ruler } = await render();
    const viewportWindow = el.children.find(child => child.className === 'viewport-window');
    const api = { state: { selection: row.selection }, setSelection() {} };
    const cleanup = ruler.config.onInit(api);

    line.viewport.selection.setRange(130, 160);
    ruler.config.onChange(api);

    assert.deepEqual(line.viewport.selection.ranges, row.ranges);
    assert.equal(viewportWindow.hidden, row.hidden);
    cleanup();
    line.viewport.resetRange();
});

test('ranges selected before rendering are shown over all profiles', async () => {
    const { el } = await render({ selection: [{ start: 115, end: 130 }] });
    const selectionsEl = el.children.find(child => child.className === 'selections');

    assert.deepEqual(selectionsEl.children.map(position), [[0.1, 0.2]]);
});

test('selected ranges of the primary timeline are followed while the ruler is initialized', async () => {
    const { el, line, ruler } = await render();
    const selectionsEl = el.children.find(child => child.className === 'selections');

    assert.deepEqual(selectionsEl.children, []);
    const cleanup = ruler.config.onInit({ state: { selection: null }, setSelection() {} });

    line.range.selection.setRanges([{ start: 115, end: 130 }, { start: 220, end: 250 }]);
    assert.deepEqual(selectionsEl.children.map(position), [[0.1, 0.2], [0.8, 1]]);
    line.range.selection.resetRange();
    assert.deepEqual(selectionsEl.children, []);

    cleanup();
    line.range.selection.setRange(115, 130);
    assert.deepEqual(selectionsEl.children, []);
    line.range.selection.resetRange();
});
