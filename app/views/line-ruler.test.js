import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { createLineFixture, createProfileFixture, denseValues, joinSession } from '../../test/fixtures/profile.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { createState, rangeToSegments } from './ruler-range.js';
import { binsPerColumn } from './bins-histogram/index.js';
import { lineViewportBounds, lineZoom, setLineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { RangeSelection } from '../prepare/computations/range.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

let viewName;
let renderLineRuler;
let viewOptions;

evaluateModule(new URL('./line-ruler.js', import.meta.url), {
    discovery: {
        view: {
            define(name, render, options) {
                viewName = name;
                renderLineRuler = render;
                viewOptions = options;
            }
        }
    },
    require: () => ({
        resolveScopeProfileLine,
        lineViewportBounds,
        lineZoom,
        setLineZoom,
        subscribeLineZoom,
        createState,
        rangeToSegments,
        binsPerColumn
    }),
    window: { devicePixelRatio: 1 }
});

const data = { data: true };
// A line formats the labels of its rulers
const timelineScope = {
    scopeLine: {
        type: 'timeline',
        formatScaleValue: String
    }
};

// Renders a line ruler of the width with a harness, keeping the forwarded config and the API of the ruler
function mount(harness, props, context, width = 100) {
    const element = harness.createRuler(width);
    const mounted = { element, config: null, api: null };
    const render = (el, config, input, scope) => {
        const onInit = (api, ...args) => {
            mounted.api = api;
            return config.onInit(api, ...args);
        };

        mounted.config = config;
        return harness.render(el, { ...config, onInit }, input, scope);
    };

    renderLineRuler.call({ render }, element, props, data, context);
    harness.setActive(element);

    return mounted;
}

// A harness rendering details by the context of the details adapter, the last one is kept
function createDetailsHarness() {
    const details = { context: null };
    const render = (el, config, input, scope) => {
        assert.equal(input, data);
        details.context = config.context(input, scope);
    };

    return { harness: createRulerHarness(render), details };
}

// Hovers the ruler at x and returns the context of its details
function hoverDetails(harness, details, x) {
    harness.move(x);
    harness.showTooltip();

    return details.context;
}

const binsOf = context => [context.segmentStart, context.segmentEnd, context.timeStart, context.timeEnd];

// A range manager storing written ranges rounded, so an echo of a written preview differs from it
function createRoundingManager() {
    const listeners = [];
    const round = range => ({
        start: Math.round(range.start),
        end: Math.round(range.end)
    });

    return {
        listeners,
        ranges: null,
        setRanges(ranges) {
            this.ranges = ranges.map(round);
            for (let i = 0; i < listeners.length; i++) {
                listeners[i]();
            }
        },
        subscribe(listener) {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        }
    };
}

const createTimeSelection = () => new RangeSelection({ name: 'time', unit: 'us' });

// A line of 100 units of dense events from 0; a second profile of the recording from -20 widens the viewport bounds
// of time lines to the range from -20 to 100
async function createZoomFixture() {
    const { profile } = await createLineFixture({ values: denseValues(100) });
    const other = await createProfileFixture({ startTime: -20 });

    joinSession([profile, other.profile]);

    const context = {
        primaryProfile: profile,
        data: { profiles: [profile, other.profile] }
    };

    return { line: profile.timeline, context };
}

test('renders a ruler in place with the range, segments and selection forwarded unchanged', () => {
    const element = {};
    const props = {
        range: { start: -0.5, end: 0.5 },
        segments: [-0.5, -0.25, 0.125, 0.5],
        selection: [{ start: -1, end: 0.125 }],
        details: { view: 'struct' },
        labels: 'bottom'
    };
    let rendered;
    const render = (...args) => {
        rendered = args;
    };

    renderLineRuler.call({ render }, element, props, data, timelineScope);

    const [target, config, input, scope] = rendered;

    assert.equal(viewName, 'line-ruler');
    assert.equal(viewOptions.tag, false);
    assert.equal(target, element);
    assert.equal(input, data);
    assert.equal(scope, timelineScope);
    assert.equal(config.view, 'ruler');
    assert.equal(config.range, props.range);
    assert.equal(config.segments, props.segments);
    assert.equal(config.selection, props.selection);
    assert.equal(config.multiple, true);
    assert.equal(config.labels, 'bottom');
    assert.equal(config.details.content, props.details);
    assert.equal(config.bounds, null);
    assert.equal(config.onRangeChange, false);
});

test.each([
    [false, { start: 110, end: 115 }],
    [true, [{ start: 110, end: 115 }, { start: 120, end: 125 }]]
])('a range manager instead of the selection gives its ranges, multiple=%s', (multiple, selection) => {
    const manager = createRoundingManager();
    const props = {
        range: [100, 200],
        multiple,
        rangeManager: manager,
        selection: []
    };
    let config;
    const render = (el, value) => {
        config = value;
    };

    manager.ranges = [{ start: 110, end: 115 }, { start: 120, end: 125 }];
    renderLineRuler.call({ render }, {}, props, data, timelineScope);
    assert.deepEqual(config.selection, selection);
    assert.equal('rangeManager' in config, false);
});

// Labels count from the start of the range in the unit of its length
test.each([
    ['timeline', 1_000_000, '0.1s'],
    ['timeline', { start: 1000, end: 2000 }, '0.1ms'],
    ['timeline', [1000, 2000], '0.1ms'],
    ['memline', 100_000, '10Kb'],
    ['memline', 1_000_000, '0.1Mb'],
    ['memline', { start: 1000, end: 101_000 }, '10Kb']
])('the second label of a %s over %o is %s', async (line, range, label) => {
    const { profile } = await createProfileFixture();
    const harness = createRulerHarness();
    const { element } = mount(harness, { line, range }, { primaryProfile: profile });

    assert.equal(harness.labels(element)[1], label);
});

// Lines of any type format the labels of their rulers, the view knows nothing of their units
test('labels are values of the line on the scale: from its start, with its length and the step', () => {
    const harness = createRulerHarness();
    const formatScaleValue = (value, scaleLength, step) => `${value}/${scaleLength}/${step}`;
    const scope = {
        scopeLine: {
            type: 'other',
            formatScaleValue
        }
    };
    const { element } = mount(harness, { range: [100, 200] }, scope);

    assert.deepEqual(harness.labels(element).slice(0, 3), ['0/100/10', '10/100/10', '20/100/10']);
});

// A label formatter may be called without a step, as by a ruler of the documented signature
test.each([
    ['timeline', 2_000_000, 500_000, '0.5s'],
    ['memline', 100_000, 12_500, '12.5Kb'],
    ['memline', 100_000, 25_000, '25Kb']
])('a label of a %s over %s without a step for %s is %s', async (line, range, value, label) => {
    const { profile } = await createProfileFixture();
    const { config } = mount(createRulerHarness(), { line, range }, { primaryProfile: profile });

    assert.equal(config.formatLabel(value, { start: 0, end: range }), label);
});

// Zoomed labels keep the unit of the viewport bounds: 30 seconds of a timeline (widened by a profile of the recording),
// 160 bytes of a memline
test.each([
    ['timeline', [0, 30_000_000], ['0s', '5s', '10s']],
    ['timeline', [10_000_000, 12_000_000], ['10.00s', '10.25s', '10.50s']],
    ['timeline', [10_000_000, 10_001_000], ['10.0000s', '10.0001s', '10.0002s']],
    ['memline', [0, 160], ['0.000Kb', '0.025Kb', '0.050Kb']],
    ['memline', [10, 12], ['0.01000Kb', '0.01025Kb', '0.01050Kb']]
])('labels of a %s zoomed to %o of its bounds start with %o', async (type, zoom, labels) => {
    const { profile } = await createProfileFixture({ startTime: 456_706_000_000 });
    const start = lineViewportBounds(profile.timeline).start;
    const profiles = [profile, { timeline: { axisStart: start, axisEnd: start + 30_000_000 } }];
    const line = profile[type];

    joinSession(profiles);

    const origin = lineViewportBounds(line).start;
    const harness = createRulerHarness();

    line.zoom.selection.setRange(origin + zoom[0], origin + zoom[1]);

    const { element } = mount(harness, { line: type, zoom: true }, { primaryProfile: profile, data: { profiles } });

    assert.deepEqual(harness.labels(element).slice(0, 3), labels);
});

// The grid may start after the bounds start: details count time from the grid, labels from the bounds
test.each([
    [0, [20, 21]],
    [8, [12, 13]]
])('details of a zoomed ruler with a grid at %s count time %o from the grid start', async (gridStart, time) => {
    const { profile } = await createProfileFixture({ startTime: 456_706_000_000 });
    const { harness, details } = createDetailsHarness();
    const line = profile.timeline;
    const bounds = lineViewportBounds(line);
    const props = {
        range: { start: bounds.start + gridStart, end: bounds.start + gridStart + 40 },
        segments: 40,
        zoom: true,
        details: { view: 'struct' }
    };

    line.zoom.selection.setRange(bounds.start + 10, bounds.start + 30);
    mount(harness, props, { primaryProfile: profile });

    const context = hoverDetails(harness, details, 50);

    assert.deepEqual([context.timeStart, context.timeEnd], time);
    assert.deepEqual([context.labelStart, context.labelEnd], [20, 21]);
    assert.equal(context.resolution, 0.1);
});

// A ruler over [100, 130] with 10 segments of 3 or none, hovered at 112
test.each([
    {
        segments: 10,
        selection: null,
        expected: {
            timeStart: 12,
            timeEnd: 15,
            segmentStart: 4,
            segmentEnd: 4
        }
    },
    {
        segments: 10,
        selection: [{ start: 110, end: 115 }],
        expected: {
            timeStart: 10,
            timeEnd: 15,
            segmentStart: 3,
            segmentEnd: 4
        }
    },
    {
        segments: null,
        selection: null,
        expected: {
            timeStart: 12,
            timeEnd: 12,
            segmentStart: 0,
            segmentEnd: -1
        }
    }
])(
    'details are relative to the range start with inclusive segment indices, segments=$segments, selection=$selection',
    async row => {
        const { profile } = await createProfileFixture();
        const { harness, details } = createDetailsHarness();
        const manager = profile.timeline.range.selection;
        const props = {
            range: { start: 100, end: 130 },
            segments: row.segments,
            rangeManager: manager,
            details: { view: 'struct' }
        };

        manager.setRanges(row.selection);

        const { api } = mount(harness, props, { primaryProfile: profile });

        harness.move(40);
        harness.showTooltip();

        const { timeStart, timeEnd, segmentStart, segmentEnd } = details.context;

        assert.deepEqual({ timeStart, timeEnd, segmentStart, segmentEnd }, row.expected);
        assert.deepEqual([details.context.labelStart, details.context.labelEnd], [timeStart, timeEnd]);
        assert.equal(details.context.duration, 30);
        assert.equal(resolveScopeProfileLine(null, details.context), profile.timeline);
        assert.equal('segmentStart' in api.state, false);
    }
);

test.each([
    [false, [{ start: 102, end: 108 }, { start: 110, end: 115 }, null]],
    [true, [[{ start: 102, end: 108 }], [{ start: 110, end: 115 }, { start: 120, end: 125 }], null]]
])('follows the range manager without calling onChange, multiple=%s', (multiple, selections) => {
    const manager = createTimeSelection();
    const observed = [];
    let changes = 0;
    const props = {
        range: [100, 200],
        multiple,
        rangeManager: manager,
        onChange: () => changes++
    };

    manager.setRange(102, 108);

    const { api } = mount(createRulerHarness(), props, timelineScope);

    observed.push(api.state.selection);
    manager.setRanges([{ start: 110, end: 115 }, { start: 120, end: 125 }]);
    observed.push(api.state.selection);
    manager.resetRange();
    observed.push(api.state.selection);
    assert.deepEqual(observed, selections);
    assert.equal(changes, 0);
});

test.each([false, true])(
    'writes previews to the range manager and calls onChange and onCommit of the caller, multiple=%s',
    multiple => {
        const manager = createTimeSelection();
        const harness = createRulerHarness();
        const calls = [];
        const onChange = value => {
            assert.equal(value, mounted.api);
            calls.push(['change', manager.ranges]);
        };
        const props = {
            range: { start: 100, end: 130 },
            multiple,
            rangeManager: manager,
            onChange,
            onCommit: () => calls.push(['commit', manager.ranges])
        };
        const mounted = mount(harness, props, timelineScope);

        harness.pointerDown(40, mounted.element);
        harness.move(50);
        harness.pointerUp(50);
        assert.deepEqual(calls, [
            ['change', [{ start: 112, end: 115 }]],
            ['commit', [{ start: 112, end: 115 }]]
        ]);
    }
);

test('own writes to a normalizing range manager keep a drag, its later changes are followed', () => {
    const manager = createRoundingManager();
    const harness = createRulerHarness();
    let commits = 0;
    const props = {
        range: [0, 128],
        rangeManager: manager,
        onCommit: () => commits++
    };
    const { element, api } = mount(harness, props, timelineScope, 128);

    harness.pointerDown(32, element);
    harness.move(52.5);
    harness.move(70.5);
    harness.pointerUp(70.5);
    assert.deepEqual(api.state.selection, [{ start: 32, end: 70.5 }]);
    assert.deepEqual(manager.ranges, [{ start: 32, end: 71 }]);
    assert.equal(commits, 1);

    manager.setRanges([{ start: 1.4, end: 2.6 }]);
    assert.deepEqual(api.state.selection, [{ start: 1, end: 3 }]);
});

test('destruction ends following the range manager and the zoom and calls the cleanup of the caller once', async () => {
    const { line, context } = await createZoomFixture();
    const manager = createRoundingManager();
    const harness = createRulerHarness();
    const updates = [];
    let cleanups = 0;
    const props = {
        zoom: true,
        rangeManager: manager,
        onInit: () => () => cleanups++
    };
    const { element, api } = mount(harness, props, context);

    api.setSelection = selection => updates.push(selection);
    api.setRange = range => updates.push(range);
    line.zoom.selection.setRange(0, 20);
    manager.setRanges([{ start: 1, end: 2 }]);
    assert.equal(updates.length, 2);

    harness.destroy(element);
    line.zoom.selection.setRange(10, 30);
    line.viewport.selection.setRange(0, 50);
    manager.setRanges([{ start: 3, end: 4 }]);
    assert.equal(updates.length, 2);
    assert.equal(cleanups, 1);
});

// A handle is dragged from `from` to the opposite edge, across it and back; the manager holds every preview.
// A continuous scale stops at one CSS pixel, a segmented one at the nearest boundary
test.each([
    {
        multiple: false,
        segments: null,
        trigger: 'start',
        from: 20,
        anchor: 60,
        crossed: 80,
        previews: [{ start: 159, end: 160 }, { start: 160, end: 180 }, { start: 160, end: 161 }],
        selection: { start: 160, end: 161 }
    },
    {
        multiple: true,
        segments: 10,
        trigger: 'finish',
        from: 60,
        anchor: 20,
        crossed: 10,
        previews: [{ start: 120, end: 130 }, { start: 110, end: 120 }, { start: 110, end: 120 }],
        selection: [{ start: 110, end: 120 }]
    }
])('a minimum resize of the $trigger is kept in the range manager and committed, multiple=$multiple', row => {
    const manager = createTimeSelection();
    const harness = createRulerHarness();
    const ranges = [];
    let commits = 0;
    const props = {
        range: [100, 200],
        segments: row.segments,
        multiple: row.multiple,
        rangeManager: manager,
        onCommit: () => commits++
    };

    manager.setRange(120, 160);

    const { element, api } = mount(harness, props, timelineScope);

    harness.pointerDown(row.from, harness.selectionHandle(element, row.trigger));
    harness.move(row.anchor);
    ranges.push(...manager.ranges);
    harness.move(row.crossed);
    ranges.push(...manager.ranges);
    harness.move(row.anchor);
    harness.pointerUp(row.anchor);
    ranges.push(...manager.ranges);
    assert.deepEqual(ranges, row.previews);
    assert.deepEqual(api.state.selection, row.selection);
    assert.equal(commits, 1);
});

test('a zoomed ruler shows the line zoom within the viewport bounds', async () => {
    const { line, context } = await createZoomFixture();

    line.zoom.selection.setRange(-10, 10);

    const { config, api } = mount(createRulerHarness(), { range: { start: 0, end: 1 }, zoom: true }, context);

    assert.deepEqual(config.bounds, { start: -20, end: 100 });
    assert.deepEqual(api.state.range, { start: -10, end: 10 });
});

test('a zoomed ruler follows the line zoom', async () => {
    const { line, context } = await createZoomFixture();
    const { api } = mount(createRulerHarness(), { zoom: true }, context);

    line.zoom.selection.setRange(-15, -5);
    assert.deepEqual(api.state.range, { start: -15, end: -5 });

    line.zoom.resetRange();
    assert.deepEqual(api.state.range, { start: -20, end: 100 });
});

test('without a zoom request a zoomed ruler follows the line viewport', async () => {
    const { line, context } = await createZoomFixture();
    const { api } = mount(createRulerHarness(), { zoom: true }, context);

    line.viewport.selection.setRange(-10, 30);
    assert.deepEqual(api.state.range, { start: -10, end: 30 });

    line.viewport.resetRange();
    assert.deepEqual(api.state.range, { start: -20, end: 100 });
});

// A wheel over a ruler of 100px requests the line zoom kept within the viewport, the whole viewport is no request
test.each([
    {
        name: 'a pan',
        viewport: null,
        zoom: [{ start: -10, end: 10 }],
        x: 50,
        wheel: { deltaX: 50 },
        request: [{ start: 0, end: 20 }],
        range: { start: 0, end: 20 }
    },
    {
        name: 'a zoom in by half at the start',
        viewport: null,
        zoom: null,
        x: 0,
        wheel: { deltaY: -Math.log(2) / 0.0015, ctrlKey: true },
        request: [{ start: -20, end: 40 }],
        range: { start: -20, end: 40 }
    },
    {
        name: 'a zoom out to the viewport bounds',
        viewport: null,
        zoom: [{ start: -10, end: 10 }],
        x: 50,
        wheel: { deltaY: 10_000, ctrlKey: true },
        request: null,
        range: { start: -20, end: 100 }
    },
    {
        name: 'a zoom out over a viewport',
        viewport: [{ start: -10, end: 30 }],
        zoom: null,
        x: 50,
        wheel: { deltaY: 10_000, ctrlKey: true },
        request: null,
        range: { start: -10, end: 30 }
    },
    {
        name: 'a pan past a viewport',
        viewport: [{ start: -10, end: 30 }],
        zoom: [{ start: 10, end: 30 }],
        x: 50,
        wheel: { deltaX: 50 },
        request: [{ start: 10, end: 30 }],
        range: { start: 10, end: 30 }
    }
])('$name with a wheel requests the line zoom of a zoomed ruler', async row => {
    const { line, context } = await createZoomFixture();
    const harness = createRulerHarness();

    line.viewport.selection.setRanges(row.viewport);
    line.zoom.selection.setRanges(row.zoom);

    const { api } = mount(harness, { zoom: true }, context);

    harness.wheel(row.x, row.wheel);
    assert.deepEqual(line.zoom.selection.ranges, row.request);
    assert.deepEqual(api.state.range, row.range);
});

// The timeline of a profile has viewport bounds from 10 to 40. A grid of 64 bins over 10–42 within a zoom across
// 8 pixels: 32 bins within 13–29 merge by 8 into columns of 4 units, 8 bins within 14–18 are columns of 1 unit
const gridOfSegments = {
    range: { start: 10, end: 42 },
    segments: 64
};
const gridOfWindow = {
    window: { value: { scopeViewport: { start: 10, end: 42 }, binCount: 64 } }
};
const gridOfLaterWindow = {
    window: { value: { scopeViewport: { start: 26, end: 42 }, binCount: 16 } }
};

test.each([
    {
        name: 'a range and segments',
        grid: gridOfSegments,
        zoom: { start: 13, end: 29 },
        segments: [13, 14, 18, 22, 26, 29]
    },
    {
        name: 'a range and segments',
        grid: gridOfSegments,
        zoom: { start: 14, end: 18 },
        segments: [14, 15, 16, 17, 18]
    },
    {
        name: 'a window value',
        grid: gridOfWindow,
        zoom: { start: 13, end: 29 },
        segments: [13, 14, 18, 22, 26, 29]
    },
    {
        name: 'a window value',
        grid: gridOfLaterWindow,
        zoom: { start: 29, end: 37 },
        segments: [29, 30, 32, 34, 36, 37]
    }
])('a zoomed ruler over a grid of bins by $name within $zoom is segmented by columns of bins', async row => {
    const { profile } = await createProfileFixture();
    const props = {
        ...row.grid,
        zoom: true
    };

    profile.timeline.zoom.selection.setRange(row.zoom.start, row.zoom.end);

    const { api } = mount(createRulerHarness(), props, { primaryProfile: profile }, 8);

    assert.deepEqual(Array.from(api.state.segments), row.segments);
});

// Bins are half a unit; the zoom is across 8 pixels
test.each([
    [{ start: 13, end: 29 }, 1.5, [8, 15, 4, 8]],
    [{ start: 13, end: 29 }, 0.2, [6, 7, 3, 4]],
    [{ start: 14, end: 18 }, 2.5, [10, 11, 5, 6]]
])(
    'details of a column of a grid within %o at %s px are its bins %o and time from the grid start',
    async (zoom, x, bins) => {
        const { profile } = await createProfileFixture();
        const { harness, details } = createDetailsHarness();
        const props = {
            ...gridOfSegments,
            zoom: true,
            details: { view: 'struct' }
        };

        profile.timeline.zoom.selection.setRange(zoom.start, zoom.end);
        mount(harness, props, { primaryProfile: profile, scopeViewport: 'outer' }, 8);

        const context = hoverDetails(harness, details, x);

        assert.deepEqual(binsOf(context), bins);
        assert.deepEqual(context.scopeViewport, { start: 10, end: 42 });
        assert.equal(context.binCount, 64);
    }
);

test('a new window value gives a zoomed ruler its grid', async () => {
    const { profile } = await createProfileFixture();
    const { harness, details } = createDetailsHarness();
    const line = profile.timeline;
    const window = { value: gridOfWindow.window.value };
    const props = {
        window,
        zoom: true,
        details: { view: 'struct' }
    };

    line.zoom.selection.setRange(13, 29);

    const { api } = mount(harness, props, { primaryProfile: profile }, 8);

    // 8 of the 16 bins of the new window across 8 pixels merge by 2
    window.value = gridOfLaterWindow.window.value;
    line.zoom.selection.setRange(28, 36);
    assert.deepEqual(Array.from(api.state.segments), [28, 30, 32, 34, 36]);

    const context = hoverDetails(harness, details, 2.5);

    assert.deepEqual(binsOf(context), [4, 5, 4, 6]);
    assert.deepEqual(context.scopeViewport, { start: 26, end: 42 });
    assert.equal(context.binCount, 16);
});
