import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { lineViewport, lineViewportBounds, lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

const query = jora.setup({ methods });

function createElement(tagName, className = '') {
    const element = {
        tagName,
        className,
        children: [],
        hidden: false,
        listeners: new Map(),
        textContent: '',
        classList: {
            add: name => element.className += ' ' + name
        },
        style: {
            values: new Map(),
            setProperty: (name, value) => element.style.values.set(name, value)
        },
        append: (...children) => element.children.push(...children),
        replaceChildren: (...children) => element.children = children,
        addEventListener: (name, callback) => element.listeners.set(name, callback)
    };

    return element;
}

const position = element => [element.style.values.get('--x1'), element.style.values.get('--x2')];
const windowState = element => [element.hidden, ...position(element)];

// Two profiles over 100–200 and 150–250
async function createProfiles() {
    const first = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const second = await createLineFixture({ origin: 150, values: new Uint32Array([100]) });

    return [first.profile, second.profile];
}

// Items of a bucket, a profile with its state
const toItems = profiles => profiles.map(profile => ({ profile }));

// The context of a page of the profiles with one of them, or none, as the primary profile
function createContext(profiles, primaryProfile) {
    return {
        primaryProfile,
        data: { profiles }
    };
}

function render(props, data, context) {
    const renders = [];
    const tooltips = [];
    const actions = [];
    let renderView;

    evaluateModule(new URL('./timeline-profiles.js', import.meta.url), {
        utils: { createElement },
        lineZoom,
        subscribeLineZoom,
        lineViewport,
        lineViewportBounds,
        document: { createElement },
        discovery: {
            view: { define: (_, callback) => renderView = callback },
            query: (text, input) => query(text)(input),
            action: { call: (name, profile) => actions.push([name, profile]) }
        }
    });

    const el = createElement('div');
    const host = {
        tooltip: (target, config, input) => tooltips.push([target, input]),
        render: (target, config, input, scope) => renders.push({ target, config, data: input, scope })
    };
    const byView = view => renders.filter(item => item.config.view === view);
    const byClassName = className => el.children.find(child => child.className === className);

    renderView.call(host, el, props, data, context);

    return {
        el,
        bars: el.children.filter(child => child.className.startsWith('profile')),
        buttons: el.children.filter(child => child.tagName === 'button'),
        histograms: byView('bins-histogram'),
        ruler: byView('ruler')[0],
        viewportWindow: byClassName('viewport-window'),
        zoomWindow: byClassName('zoom-window'),
        selections: byClassName('selections'),
        tooltips,
        actions
    };
}

// Renders the profiles with the first one as the primary profile
async function renderPrimary() {
    const profiles = await createProfiles();
    const view = render({}, toItems(profiles), createContext(profiles, profiles[0]));

    return { ...view, line: profiles[0].timeline };
}

// The API of the ruler, recording the selections set by the view
function createRulerApi(selection) {
    const api = {
        state: { selection },
        selections: [],
        setSelection: value => api.selections.push(value)
    };

    return api;
}

// The first and the end bin of nonzero bins as shares of all bins
function nonzeroSpan(bins) {
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

    return [first / bins.length, (last + 1) / bins.length];
}

test.each([
    {
        name: 'profiles of the data',
        input: items => [{}, items],
        range: 150,
        positions: [[0, 100 / 150], [50 / 150, 1]]
    },
    {
        name: 'profiles of the props over the data',
        input: items => [{ profiles: items }, items.slice(1)],
        range: 150,
        positions: [[0, 100 / 150], [50 / 150, 1]]
    },
    {
        name: 'a range from zero',
        input: items => [{ startTime: 0, endTime: 300 }, items],
        range: 300,
        positions: [[100 / 300, 200 / 300], [150 / 300, 250 / 300]]
    },
    {
        name: 'a range to an end time',
        input: items => [{ endTime: 300 }, items],
        range: 200,
        positions: [[0, 0.5], [0.25, 0.75]]
    }
])('bars of $name are placed in the range of the bucket', async row => {
    const profiles = await createProfiles();
    const [props, data] = row.input(toItems(profiles));
    const { el, bars } = render(props, data, createContext(profiles, null));

    assert.equal(el.style.values.get('--range'), row.range);
    assert.deepEqual(bars.map(position), row.positions);
});

test('data other than an array has no bars', async () => {
    const profiles = await createProfiles();
    const { el, bars } = render({}, { profile: profiles[0] }, createContext(profiles, null));

    assert.equal(el.style.values.get('--range'), 0);
    assert.deepEqual(bars, []);
});

// The process met first has fewer events of its threads than the one met next
test('profiles are grouped by process, the process with more events of its threads first', async () => {
    const [first, second] = await createProfiles();
    const third = (await createLineFixture({ origin: 120, values: new Uint32Array([50]) })).profile;
    const fewer = { threads: [{ events: [1, 2] }] };
    const more = { threads: [{ events: [1, 2] }, { events: [3] }] };

    first.thread = { process: fewer };
    second.thread = { process: more };
    third.thread = { process: fewer };

    const { tooltips } = render({}, toItems([first, second, third]), createContext([], null));

    assert.deepEqual(tooltips.map(tooltip => tooltip[1]), [second, first, third]);
});

test('a bar holds the name of its profile or a placeholder and a viewport', async () => {
    const profiles = await createProfiles();
    const describeChildren = bar => bar.children.map(child => [child.className, child.textContent]);

    profiles[0].name = 'Main';

    const { bars } = render({}, toItems(profiles), createContext(profiles, null));

    assert.deepEqual(bars.map(describeChildren), [
        [['caption', 'Main'], ['viewport', '']],
        [['caption', '(unnamed profile)'], ['viewport', '']]
    ]);
});

test('the bar of the primary profile is selected, a click on another bar selects its profile', async () => {
    const profiles = await createProfiles();
    const { bars, actions } = render({}, toItems(profiles), createContext(profiles, profiles[1]));

    bars[0].listeners.get('click')();

    assert.deepEqual(bars.map(bar => bar.className), ['profile', 'profile selected']);
    assert.equal(bars[1].listeners.has('click'), false);
    assert.deepEqual(actions, [['selectProfile', profiles[0]]]);
});

test('the bar of a disabled profile is marked', async () => {
    const profiles = await createProfiles();
    const items = [{ disabled: true, profile: profiles[0] }, { disabled: false, profile: profiles[1] }];
    const { bars } = render({}, items, createContext(profiles, profiles[0]));

    assert.deepEqual(bars.map(bar => bar.className), ['profile disabled selected', 'profile']);
});

test('a button before each bar toggles its profile', async () => {
    const profiles = await createProfiles();
    const { el, buttons, bars, actions } = render({}, toItems(profiles), createContext(profiles, profiles[0]));

    buttons[1].listeners.get('click')();
    buttons[0].listeners.get('click')();

    assert.deepEqual(el.children.slice(0, 4), [buttons[0], bars[0], buttons[1], bars[1]]);
    assert.deepEqual(actions, [['toggleProfile', profiles[1]], ['toggleProfile', profiles[0]]]);
});

test('each bar has the tooltip of its profile', async () => {
    const profiles = await createProfiles();
    const { bars, tooltips } = render({}, toItems(profiles), createContext(profiles, null));

    assert.deepEqual(tooltips, [[bars[0], profiles[0]], [bars[1], profiles[1]]]);
});

test('each bar has a histogram of its profile over the time of all profiles', async () => {
    const profiles = await createProfiles();
    const items = toItems(profiles);
    const { bars, histograms } = render({}, items, createContext(profiles, null));
    const evaluate = histogram => query(histogram.config.data)(histogram.data, {});
    const results = histograms.map(evaluate);

    assert.deepEqual(histograms.map(histogram => histogram.target), bars);
    assert.deepEqual(histograms.map(histogram => histogram.data.profile), profiles);
    assert.deepEqual(histograms[0].data.profiles, items);
    assert.equal(histograms[0].config.binsMax, true);
    assert.deepEqual(results.map(result => [result.skip, result.total]), [[0, 150], [50, 150]]);
    assert.deepEqual(results.map(result => nonzeroSpan(result.bins)), [[0, 2 / 3], [1 / 3, 1]]);
});

test.each([
    {
        name: 'without a primary profile',
        props: {},
        primary: () => null
    },
    {
        name: 'for a primary profile without a bar',
        props: {},
        primary: () => ({ timeline: {} })
    },
    {
        name: 'for an empty range',
        props: { startTime: 100, endTime: 100 },
        primary: profiles => profiles[0]
    }
])('no viewport ruler is shown $name', async row => {
    const profiles = await createProfiles();
    const view = render(row.props, toItems(profiles), createContext(profiles, row.primary(profiles)));

    assert.equal(view.ruler, undefined);
    assert.equal(view.viewportWindow, undefined);
    assert.equal(view.zoomWindow, undefined);
    assert.equal(view.selections, undefined);
});

test('the ruler of the primary bar spans the range of all profiles, without labels and grid', async () => {
    const { bars, ruler } = await renderPrimary();

    assert.equal(ruler.target, bars[0]);
    assert.deepEqual({ ...ruler.config.range }, { start: 100, end: 250 });
    assert.equal(ruler.config.labels, false);
    assert.equal(ruler.config.grid, false);
});

test.each([
    {
        name: 'no viewport',
        viewport: null,
        selection: null,
        window: [true, 0, 1]
    },
    {
        name: 'a viewport',
        viewport: { start: 130, end: 160 },
        selection: { start: 130, end: 160 },
        window: [false, 0.2, 0.4]
    }
])('with $name requested, the ruler selection and the viewport window start at it', async row => {
    const profiles = await createProfiles();
    const line = profiles[0].timeline;

    line.viewport.selection.setRanges(row.viewport && [row.viewport]);

    const view = render({}, toItems(profiles), createContext(profiles, profiles[0]));

    assert.deepEqual(view.ruler.config.selection, row.selection);
    assert.deepEqual(windowState(view.viewportWindow), row.window);
    assert.deepEqual(windowState(view.zoomWindow), [true, 0, 1]);
});

test('with a zoom requested, the zoom window starts at it', async () => {
    const profiles = await createProfiles();

    profiles[0].timeline.zoom.selection.setRange(145, 160);

    const view = render({}, toItems(profiles), createContext(profiles, profiles[0]));

    assert.deepEqual(windowState(view.zoomWindow), [false, 0.3, 0.4]);
});

test.each([
    {
        name: 'a viewport',
        change: line => line.viewport.selection.setRange(130, 160),
        viewport: [false, 0.2, 0.4],
        zoom: [true, 0, 1]
    },
    {
        name: 'a zoom',
        change: line => line.zoom.selection.setRange(145, 160),
        viewport: [true, 0, 1],
        zoom: [false, 0.3, 0.4]
    }
])('windows follow a request of $name', async row => {
    const view = await renderPrimary();

    view.ruler.config.onInit(createRulerApi(null));
    row.change(view.line);

    assert.deepEqual(windowState(view.viewportWindow), row.viewport);
    assert.deepEqual(windowState(view.zoomWindow), row.zoom);
});

test('the ruler selection follows the requested viewport, not the zoom within it', async () => {
    const { line, ruler } = await renderPrimary();
    const api = createRulerApi(null);

    ruler.config.onInit(api);
    line.viewport.selection.setRange(130, 160);
    assert.deepEqual(api.selections.at(-1), { start: 130, end: 160 });

    line.zoom.selection.setRange(145, 160);
    assert.deepEqual(api.selections.at(-1), { start: 130, end: 160 });

    line.viewport.resetRange();
    assert.equal(api.selections.at(-1), null);
});

test('a viewport requested by the ruler is not echoed back to it', async () => {
    const { line, ruler } = await renderPrimary();
    const api = createRulerApi({ start: 175, end: 205 });

    ruler.config.onInit(api);
    ruler.config.onChange(api);
    assert.deepEqual(line.viewport.selection.ranges, [{ start: 175, end: 205 }]);
    assert.deepEqual(api.selections, []);

    line.viewport.selection.setRange(100, 130);
    assert.deepEqual(api.selections, [{ start: 100, end: 130 }]);
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
    const { line, ruler, viewportWindow } = await renderPrimary();
    const api = createRulerApi(row.selection);

    ruler.config.onInit(api);
    line.viewport.selection.setRange(130, 160);
    ruler.config.onChange(api);

    assert.deepEqual(line.viewport.selection.ranges, row.ranges);
    assert.equal(viewportWindow.hidden, row.hidden);
});

test('ranges selected before rendering are shown over all profiles', async () => {
    const profiles = await createProfiles();

    profiles[0].timeline.range.selection.setRanges([{ start: 115, end: 130 }]);

    const { selections } = render({}, toItems(profiles), createContext(profiles, profiles[0]));

    assert.deepEqual(selections.children.map(position), [[0.1, 0.2]]);
});

test('selected ranges of the primary timeline are followed while the ruler is initialized', async () => {
    const { line, ruler, selections } = await renderPrimary();

    ruler.config.onInit(createRulerApi(null));
    line.range.selection.setRanges([{ start: 115, end: 130 }, { start: 220, end: 250 }]);
    assert.deepEqual(selections.children.map(position), [[0.1, 0.2], [0.8, 1]]);

    line.range.selection.resetRange();
    assert.deepEqual(selections.children, []);
});

test('the cleanup of the ruler ends following the viewport, the zoom and selected ranges', async () => {
    const { line, ruler, viewportWindow, zoomWindow, selections } = await renderPrimary();
    const api = createRulerApi(null);
    const cleanup = ruler.config.onInit(api);

    cleanup();
    line.viewport.selection.setRange(130, 160);
    line.zoom.selection.setRange(140, 150);
    line.range.selection.setRange(115, 130);

    assert.deepEqual(api.selections, []);
    assert.deepEqual(windowState(viewportWindow), [true, 0, 1]);
    assert.deepEqual(windowState(zoomWindow), [true, 0, 1]);
    assert.deepEqual(selections.children, []);
});
