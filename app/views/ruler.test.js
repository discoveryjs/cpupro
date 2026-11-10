import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { queryToConfig } from '@discoveryjs/discovery/lib/core/utils/query-to-config.js';
import jora from 'jora';
import usage from './ruler.usage.js';

test('showcase details compile using Discovery configuration syntax', () => {
    const examples = [usage.demo, ...usage.examples.map(example => example.demo)].flat();
    const details = examples.map(example => example.details).filter(query => query?.startsWith('struct{'));

    assert.notEqual(details.length, 0);
    for (let i = 0; i < details.length; i++) {
        const config = queryToConfig('struct', details[i].slice('struct'.length));

        assert.equal(config.view, 'struct');
        assert.doesNotThrow(() => jora(config.data));
    }
});

const data = { data: true };
const context = { context: true };

// A ruler over [100, 200] is 100px wide, so a pointer offset is a scale offset. Callbacks are recorded in order
function setup(options = {}, render) {
    const harness = createRulerHarness(render);
    const element = harness.createRuler(100);
    const calls = [];
    let api;
    let cleanups = 0;
    const record = type => (value, input, scope) => {
        assert.equal(value, api);
        assert.equal(input, data);
        assert.equal(scope, context);
        calls.push({ type, selection: value.state.selection });
    };
    const cleanup = () => cleanups++;
    const props = {
        range: [100, 200],
        onChange: record('change'),
        onCommit: record('commit'),
        ...options,
        onRangeChange(value, input, scope) {
            assert.equal(value, api);
            assert.equal(input, data);
            assert.equal(scope, context);
            calls.push({ type: 'range', range: value.state.range });
        },
        onInit(value, input, scope) {
            api = value;
            assert.equal(value.el, element);
            assert.equal(input, data);
            assert.equal(scope, context);
            options.onInit?.(api);
            return cleanup;
        }
    };

    harness.render(element, props, data, context);
    harness.setActive(element);

    return {
        harness,
        element,
        api,
        calls,
        move: x => harness.move(x),
        down: (x, target = element) => harness.pointerDown(x, target),
        up: x => harness.pointerUp(x),
        handle: trigger => harness.selectionHandle(element, trigger),
        cleanups: () => cleanups,
        destroy: () => harness.destroy(element)
    };
}

const callTypes = view => view.calls.map(call => call.type);
const escape = {
    key: 'Escape',
    preventDefault() {}
};

test('renders numeric labels by default and passes the value, the range and the step to a label formatter', () => {
    const harness = createRulerHarness();
    const element = harness.createElement('ruler');
    const formatted = harness.createElement('ruler');
    const formatLabel = (value, range, step) => `${value}/${range.end}/${step}`;

    harness.render(element, { range: 100 }, null, {});
    harness.render(formatted, { range: 100, formatLabel }, null, {});
    assert.deepEqual(harness.labels(element), ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90']);
    assert.deepEqual(harness.labels(formatted), [
        '0/100/10', '10/100/10', '20/100/10', '30/100/10', '40/100/10', '50/100/10', '60/100/10', '70/100/10', '80/100/10', '90/100/10'
    ]);
});

// Steps are 1, 2.5 or 5 times a power of ten, at most a tenth of the range; no marker is within a tenth of a step of the end
test.each([
    [[0, 1], ['0.00', '0.25', '0.50', '0.75']],
    [[0, 0.25], ['0.00', '0.05', '0.10', '0.15', '0.20']],
    [[0, 40], ['0.00', '5.00', '10.00', '15.00', '20.00', '25.00', '30.00', '35.00']],
    [[0, 50], ['0.00', '5.00', '10.00', '15.00', '20.00', '25.00', '30.00', '35.00', '40.00', '45.00']],
    [[0, 10.25], ['0.00', '2.50', '5.00', '7.50']],
    [[0, 0], []]
])('a range of %o has markers at %o', (range, labels) => {
    const formatLabel = value => value.toFixed(2);
    const view = setup({ range, formatLabel });

    assert.deepEqual(view.harness.labels(view.element), labels);
});

test.each([
    {
        grid: undefined,
        labels: undefined,
        gridData: 'true',
        labelsData: 'top',
        markers: true
    },
    {
        grid: false,
        labels: false,
        gridData: 'false',
        labelsData: 'none',
        markers: false
    },
    {
        grid: true,
        labels: false,
        gridData: 'true',
        labelsData: 'none',
        markers: true
    },
    {
        grid: false,
        labels: 'top',
        gridData: 'false',
        labelsData: 'top',
        markers: true
    }
])('grid and labels are independent: grid=$grid, labels=$labels', row => {
    const view = setup({ range: [-0.5, 0.5], grid: row.grid, labels: row.labels });

    assert.equal(view.element.dataset.grid, row.gridData);
    assert.equal(view.element.dataset.labels, row.labelsData);
    assert.equal(view.element.children.some(child => child.className === 'interval-marker'), row.markers);
});

test('an empty range has no markers and ignores the pointer', () => {
    let shown = 0;
    const render = () => shown++;
    const view = setup({ range: [100, 100], details: 'struct' }, render);

    assert.deepEqual(view.harness.labels(view.element), []);
    view.move(50);
    view.harness.showTooltip();
    view.down(50);
    view.move(80);
    view.up(80);
    assert.equal(shown, 0);
    assert.deepEqual(view.calls, []);
    assert.equal(view.api.state.selection, null);

    view.api.setSelection({ start: 100, end: 100 });
    assert.equal(view.element.style.values.get('--selection-start'), 0);
    assert.equal(view.element.style.values.get('--selection-end'), 0);
});

test.each([
    [false, { start: -0.5, end: 0.25 }, { start: -2, end: 3 }],
    [true, [{ start: -0.5, end: 0.25 }], [{ start: -2, end: 3 }]]
])('previews and commits in the configured selection format, multiple=%s', (multiple, preview, external) => {
    const view = setup({ range: [-1, 1], multiple });
    const { api } = view;

    view.move(25);
    assert.equal(api.state.selection, null);
    view.down(25);
    view.move(62.5);
    assert.deepEqual(api.state.selection, preview);
    assert.equal(view.element.style.values.get('--selection-start'), 0.25);
    assert.equal(view.element.style.values.get('--selection-end'), 0.625);
    assert.deepEqual(callTypes(view), ['change']);
    view.up(62.5);
    assert.deepEqual(callTypes(view), ['change', 'commit']);
    api.setSelection(external);
    assert.deepEqual(callTypes(view), ['change', 'commit']);
    view.down(90);
    view.up(90);
    assert.equal(api.state.selection, null);
    assert.deepEqual(callTypes(view), ['change', 'commit', 'change', 'commit']);
});

// A press at (25, 5) over a selection: a smaller move is a click resetting it, a longer one starts a new selection
test.each([
    [26, 5, null],
    [27, 5, { start: 125, end: 127 }],
    [25, 6, null],
    [25, 7, { start: 125, end: 126 }]
])('a press moved to (%s, %s) selects %o', (x, y, selection) => {
    const view = setup({ selection: { start: 120, end: 130 } });

    view.down(25);
    view.harness.move(x, y);
    view.up(x);
    assert.deepEqual(view.api.state.selection, selection);
    assert.deepEqual(callTypes(view), ['change', 'commit']);
});

test('a drag ends at the release position, relative to the left edge of the ruler', () => {
    const view = setup();

    view.element.left = 1000;
    view.down(1025);
    view.move(1050);
    view.up(1062.5);
    assert.deepEqual(view.api.state.selection, { start: 125, end: 162.5 });
    assert.deepEqual(view.calls.at(-1), { type: 'commit', selection: { start: 125, end: 162.5 } });
});

test('a press of a button other than the main one neither selects nor resets', () => {
    const view = setup({ selection: { start: 120, end: 130 } });
    const press = {
        buttons: 2,
        pointerId: 1,
        x: 25,
        y: 5,
        target: view.element
    };

    view.move(25);
    view.harness.hostEvents.get('pointerdown')(press);
    view.move(50);
    view.up(50);
    assert.deepEqual(view.api.state.selection, { start: 120, end: 130 });
    assert.deepEqual(view.calls, []);
});

test.each([
    null,
    10,
    [100, 110, 140, 200]
])('highlights the pointer side and captures the pointer when creating a selection inside a segment, segments=%o', segments => {
    const view = setup({ segments });
    const steps = [[70, 'finish'], [10, 'start'], [27, 'finish'], [23, 'start']];

    view.down(25);
    for (let i = 0; i < steps.length; i++) {
        const [pointer, active] = steps[i];

        view.move(pointer);
        assert.equal(view.element.dataset.activeTrigger, active);
        assert.equal(view.element.dataset.state, 'selecting');
        assert.equal(view.element.hasPointerCapture(1), true);
    }
    view.up(23);
    assert.equal(view.element.dataset.state, 'selected');
    assert.equal(view.element.dataset.activeTrigger, 'none');
    assert.equal(view.element.hasPointerCapture(1), false);
});

// The selection is moved by 15px and its finish handle dragged to 99px
test.each([
    [null, { start: 138, end: 182 }, { start: 138, end: 199 }],
    [10, { start: 140, end: 184 }, { start: 140, end: 200 }]
])('moves and resizes without rebuilding segments, segments=%s', (segments, moved, resized) => {
    const view = setup({ segments, selection: { start: 123, end: 167 } });
    const boundaries = view.api.state.segments;

    view.down(30, view.element.querySelector('.view-ruler__selection-overlay-mover'));
    view.move(45);
    view.up(45);
    assert.deepEqual(view.api.state.selection, moved);

    view.down(moved.end - 100, view.handle('finish'));
    view.move(99);
    view.up(99);
    assert.deepEqual(view.api.state.selection, resized);
    assert.equal(view.api.state.segments, boundaries);
    assert.deepEqual(callTypes(view), ['change', 'commit', 'change', 'commit']);
});

test.each([null, 100])('jumps across the original resize anchor after reaching the minimum, segments=%s', segments => {
    const view = setup({
        range: 100,
        segments,
        selection: { start: 10, end: 40 }
    });
    const pointers = [39, 39.5, 40];

    view.down(12, view.handle('start'));
    for (let i = 0; i < pointers.length; i++) {
        view.move(pointers[i] + 2);
        assert.deepEqual(view.api.state.selection, { start: 39, end: 40 });
    }
    view.move(42.5);
    assert.deepEqual(view.api.state.selection, { start: 40, end: 41 });
    view.move(82);
    view.up(82);
    assert.deepEqual(view.api.state.selection, { start: 40, end: 80 });
});

test.each([50, 200])('uses one CSS pixel for continuous pointer resize and retains committed coordinates, width=%s', width => {
    const view = setup({ range: [-1, 1], selection: { start: -0.5, end: 0.5 } });
    const minimum = { start: -0.5, end: -0.5 + 2 / width };
    const external = [{ start: 0, end: 0 }, { start: 0, end: 0.0001 }];

    view.element.width = width;
    view.down(width * 0.75 + 2, view.handle('finish'));
    view.move(width * 0.25 + 2);
    assert.deepEqual(view.api.state.selection, minimum);
    view.up(width * 0.25 + 2);
    assert.deepEqual(view.calls.at(-1), { type: 'commit', selection: minimum });

    view.element.width = width / 2;
    view.move(width / 4);
    assert.deepEqual(view.api.state.selection, minimum);
    for (let i = 0; i < external.length; i++) {
        view.api.setSelection(external[i]);
        view.move(width / 4);
        assert.deepEqual(view.api.state.selection, external[i]);
    }
});

test.each([25, 100])('retains a one-pixel selection when a new continuous drag returns to its anchor=%s', anchor => {
    const view = setup();
    const minimum = { start: 100 + anchor - 1, end: 100 + anchor };

    view.down(anchor);
    view.move(anchor - 10);
    view.move(anchor);
    view.up(anchor);
    assert.deepEqual(view.api.state.selection, minimum);
    assert.deepEqual(view.calls.at(-1), { type: 'commit', selection: minimum });
});

test.each([
    [null, { start: 120, end: 121 }],
    [10, { start: 120, end: 130 }]
])('cancels a minimum resize and restores the exact external range, segments=%s', (segments, preview) => {
    const selection = { start: 120, end: 120.001 };
    const view = setup({ segments, selection });

    view.down(selection.end - 100, view.handle('finish'));
    view.move(20);
    assert.deepEqual(view.api.state.selection, preview);
    view.harness.globalEvents.get('pointercancel')();
    assert.deepEqual(view.api.state.selection, selection);
    assert.deepEqual(callTypes(view), ['change', 'change']);
});

// An event before a gesture changes nothing; Escape is prevented only when it cancels
test.each([
    ['pointercancel', [false, false]],
    ['keydown', [false, true]]
])('%s cancels a preview and restores a multiple selection without commit', (name, prevented) => {
    const original = [{ start: 110, end: 120 }, { start: 180, end: 190 }];
    const view = setup({ multiple: true, selection: original });
    const events = [];
    const dispatch = () => {
        const event = {
            key: 'Escape',
            prevented: false,
            preventDefault() {
                this.prevented = true;
            }
        };

        view.harness.globalEvents.get(name)(event);
        events.push(event.prevented);
    };

    dispatch();
    assert.deepEqual(view.calls, []);
    view.down(40);
    view.move(65);
    dispatch();
    view.up(65);
    assert.deepEqual(view.api.state.selection, original);
    assert.deepEqual(callTypes(view), ['change', 'change']);
    assert.equal(view.element.dataset.state, 'selected');
    assert.deepEqual(events, prevented);
});

test('a key other than Escape keeps a gesture', () => {
    const view = setup();
    const keydown = {
        key: 'a',
        preventDefault() {
            assert.fail('A key other than Escape is not prevented');
        }
    };

    view.down(40);
    view.move(65);
    view.harness.globalEvents.get('keydown')(keydown);
    view.up(65);
    assert.deepEqual(view.api.state.selection, { start: 140, end: 165 });
    assert.deepEqual(callTypes(view), ['change', 'commit']);
});

test('a press on the selection shows it as edited until Escape restores it', () => {
    const view = setup({ selection: { start: 120, end: 130 } });

    view.down(25, view.element.querySelector('.view-ruler__selection-overlay-mover'));
    assert.equal(view.element.dataset.state, 'selecting');
    assert.equal(view.element.dataset.activeTrigger, 'both');
    assert.equal(view.element.hasPointerCapture(1), true);
    view.harness.globalEvents.get('keydown')(escape);
    assert.equal(view.element.dataset.state, 'selected');
    assert.equal(view.element.dataset.activeTrigger, 'none');
    assert.equal(view.element.hasPointerCapture(1), false);
    assert.deepEqual(view.calls, []);
});

test('the pointer leaving the document ends a hover and a press but not a drag', () => {
    const view = setup();
    const leave = view.harness.globalEvents.get('pointerleave');

    view.move(25);
    assert.equal(view.element.dataset.state, 'hovered');
    leave();
    assert.equal(view.element.dataset.state, 'none');

    view.api.setSelection({ start: 120, end: 130 });
    view.down(25);
    leave();
    view.up(25);
    assert.deepEqual(view.api.state.selection, { start: 120, end: 130 });
    assert.deepEqual(view.calls, []);

    view.down(25);
    view.move(50);
    leave();
    view.up(50);
    assert.deepEqual(view.api.state.selection, { start: 125, end: 150 });
    assert.deepEqual(callTypes(view), ['change', 'commit']);
});

test('dragging and text selection are prevented only over a ruler', () => {
    const view = setup();
    const prevented = [];
    const event = name => ({
        preventDefault() {
            prevented.push(name);
        }
    });

    view.harness.hostEvents.get('dragstart')(event('dragstart outside'));
    view.harness.hostEvents.get('selectstart')(event('selectstart outside'));
    view.move(25);
    view.harness.hostEvents.get('dragstart')(event('dragstart'));
    view.harness.hostEvents.get('selectstart')(event('selectstart'));
    assert.deepEqual(prevented, ['dragstart', 'selectstart']);
});

test('hover without a selection highlights and explains a segment without selecting it', () => {
    let scope;
    const render = (el, details, input, context) => {
        scope = context;
    };
    const view = setup({ segments: 10, details: 'struct' }, render);
    const segments = view.api.state.segments;

    view.move(25);
    view.harness.showTooltip();
    assert.deepEqual(scope.detail, { start: 120, end: 130 });
    assert.equal(scope.ruler, view.api.state);
    assert.equal(view.api.state.selection, null);
    assert.equal(view.element.dataset.state, 'hovered');
    assert.equal(view.element.style.values.get('--selection-start'), 0.2);
    assert.equal(view.element.style.values.get('--selection-end'), 0.3);
    assert.equal(view.api.state.segments, segments);
});

// Selected ranges are half-open and clipped to the scale; gaps have no details
test.each([
    [10, [{ start: 100, end: 125 }]],
    [50, []],
    [60, [{ start: 160, end: 180 }]],
    [70, [{ start: 160, end: 180 }]],
    [80, []]
])('details of a multiple selection at %s px are %o', (x, expected) => {
    const details = [];
    const render = (el, config, input, context) => {
        details.push({ ...context.detail });
    };
    const view = setup({
        segments: 10,
        multiple: true,
        details: 'struct',
        selection: [{ start: 90, end: 125 }, { start: 160, end: 180 }]
    }, render);

    view.move(x);
    view.harness.showTooltip();
    assert.deepEqual(details, expected);
});

test('a ruler without details shows no tooltip', () => {
    let shown = 0;
    const render = () => shown++;
    const view = setup({ segments: 10 }, render);

    view.move(25);
    view.harness.showTooltip();
    assert.equal(shown, 0);
});

const leaveRuler = view => {
    view.harness.setActive(null);
    view.move(25);
};
const cancelDrag = view => {
    view.down(25);
    view.move(50);
    view.harness.globalEvents.get('keydown')(escape);
};
const setSelection = view => view.api.setSelection({ start: 120, end: 130 });
const setRange = view => view.api.setRange([100, 150]);
const destroy = view => view.destroy();

test.each([
    ['the pointer leaves the ruler', leaveRuler],
    ['Escape cancels a drag', cancelDrag],
    ['a selection is set', setSelection],
    ['the range is set', setRange],
    ['the ruler is destroyed', destroy]
])('the details tooltip is hidden when %s', (name, action) => {
    let shown = 0;
    const render = () => shown++;
    const view = setup({ segments: 10, details: 'struct' }, render);

    view.move(25);
    view.harness.showTooltip();
    action(view);
    view.harness.showTooltip();
    assert.equal(shown, 1);
});

test('moving to another ruler ends the hover of the previous one', () => {
    const view = setup();
    const other = view.harness.createRuler(100);

    view.harness.render(other, { range: 10 }, null, {});
    view.move(25);
    assert.equal(view.element.dataset.state, 'hovered');
    view.harness.setActive(other);
    view.move(25);
    assert.equal(view.element.dataset.state, 'none');
    assert.equal(other.dataset.state, 'hovered');
});

test('delivers the latest hovered target with its interval and respects competing tooltips', () => {
    const renders = [];
    const render = (el, details, input, context) => {
        renders.push(context);
    };
    const view = setup({ segments: 10, details: 'struct' }, render);
    const first = view.element.parentNode.appendChild(view.harness.createElement('first'));
    const second = view.element.parentNode.appendChild(view.harness.createElement('second'));
    const mover = view.element.querySelector('.view-ruler__selection-overlay-mover');

    view.harness.setActive(view.element, first);
    view.move(25);
    view.harness.setActive(view.element, second);
    view.move(25);
    view.harness.showTooltip();
    assert.equal(renders.length, 1);
    assert.equal(renders[0].detailTarget, second);
    assert.deepEqual(renders[0].detail, { start: 120, end: 130 });

    // The selection overlay retains the underlying section
    view.api.setSelection({ start: 120, end: 130 });
    view.harness.setActive(view.element, mover, second);
    view.move(25);
    view.harness.showTooltip();
    assert.equal(renders[1].detailTarget, second);

    second.closest = () => second;
    view.harness.setActive(view.element, second);
    view.move(25);
    view.harness.showTooltip();
    assert.equal(renders.length, 2);

    // A tooltip owner around the ruler does not compete with it
    second.closest = () => view.harness.createElement('page');
    view.move(25);
    view.harness.showTooltip();
    assert.equal(renders.length, 3);
});

test.each([
    [[{ start: 125, end: 150 }, { start: 175, end: 200 }], 'true', [['25%', '25%'], ['75%', '25%']]],
    [[{ start: 125, end: 150 }, { start: 210, end: 230 }], 'true', [['25%', '25%']]],
    [[{ start: 125, end: 150 }], 'false', []],
    [[], 'false', []]
])('a multiple selection %o shows its visible ranges as intervals instead of the previous ones', (selection, multipleRanges, intervals) => {
    const view = setup({ multiple: true, selection: [{ start: 100, end: 110 }, { start: 190, end: 200 }] });
    const position = interval => [interval.style.values.get('left'), interval.style.values.get('width')];

    view.api.setSelection(selection);

    const ranges = view.element.querySelector('.view-ruler__ranges').children;

    assert.deepEqual(view.api.state.selection, selection);
    assert.equal(view.element.dataset.multipleRanges, multipleRanges);
    assert.deepEqual(ranges.map(position), intervals);
});

test('setSelection replaces the selection without callbacks, a changed one cancels a drag and an equal one keeps it', () => {
    const onInit = api => api.setSelection({ start: 110, end: 120 });
    const view = setup({ onInit });

    assert.deepEqual(view.api.state.selection, { start: 110, end: 120 });
    assert.deepEqual(view.calls, []);

    view.down(40);
    view.move(65);
    view.api.setSelection({ start: 140, end: 165 });
    view.up(65);
    assert.deepEqual(callTypes(view), ['change', 'commit']);

    view.down(40);
    view.move(70);
    view.api.setSelection({ start: 180, end: 190 });
    view.up(70);
    assert.deepEqual(view.api.state.selection, { start: 180, end: 190 });
    assert.deepEqual(callTypes(view), ['change', 'commit', 'change']);
});

test('destruction releases the pointer and calls the cleanup once, later updates are inert', () => {
    const view = setup({ selection: { start: 110, end: 120 } });

    view.down(30);
    view.move(50);
    view.destroy();
    view.destroy();
    assert.equal(view.element.hasPointerCapture(1), false);
    assert.equal(view.element.dataset.activeTrigger, 'none');
    assert.equal(view.cleanups(), 1);

    view.api.setSelection(null);
    view.api.setRange([0, 1]);
    view.up(50);
    assert.deepEqual(view.api.state.selection, { start: 130, end: 150 });
    assert.deepEqual(view.api.state.range, { start: 100, end: 200 });
    assert.deepEqual(callTypes(view), ['change']);
});

test('setRange moves markers and the selection without notifications', () => {
    const view = setup({ selection: { start: 120, end: 130 } });
    const { api, element } = view;

    assert.equal(element.style.values.get('--selection-start'), 0.2);
    api.setRange({ start: 120, end: 140 });
    assert.deepEqual(api.state.range, { start: 120, end: 140 });
    assert.equal(api.state.length, 20);
    assert.deepEqual(api.state.selection, { start: 120, end: 130 });
    assert.deepEqual(view.harness.labels(element), ['120', '122.5', '125', '127.5', '130', '132.5', '135', '137.5']);
    assert.equal(element.style.values.get('--selection-start'), 0);
    assert.equal(element.style.values.get('--selection-end'), 0.5);

    api.setRange([160, 120]);
    assert.deepEqual(api.state.range, { start: 120, end: 160 });
    assert.equal(element.style.values.get('--selection-end'), 0.25);
    assert.deepEqual(view.calls, []);
});

// E.g. a zoomed ruler panned past a selection on either side: all of it is out of the selection
test('a selection out of the ruler range dims all of the ruler without showing its edges', () => {
    const { api, element } = setup({ selection: { start: 120, end: 130 } });
    const interval = () => [
        element.style.values.get('--selection-start'),
        element.style.values.get('--selection-end')
    ];

    assert.equal(element.dataset.selectionInRange, 'true');
    api.setRange({ start: 140, end: 160 });
    assert.equal(element.dataset.state, 'selected');
    assert.equal(element.dataset.selectionInRange, 'false');
    assert.deepEqual(interval(), [0, 0]);
    api.setRange({ start: 100, end: 120 });
    assert.equal(element.dataset.state, 'selected');
    assert.equal(element.dataset.selectionInRange, 'false');
    assert.deepEqual(interval(), [1, 1]);
    api.setRange({ start: 125, end: 160 });
    assert.equal(element.dataset.selectionInRange, 'true');
    assert.deepEqual(interval(), [0, 5 / 35]);

    // Ranges of a multiple selection out of the ruler range are not shown
    const multiple = setup({
        multiple: true,
        selection: [{ start: 110, end: 120 }, { start: 150, end: 160 }]
    });
    const intervals = () => multiple.element.querySelector('.view-ruler__ranges').children.length;

    assert.equal(intervals(), 2);
    multiple.api.setRange({ start: 140, end: 200 });
    assert.equal(intervals(), 1);
    multiple.api.setRange({ start: 170, end: 200 });
    assert.equal(intervals(), 0);
});

test('markers are reused, hidden when fewer are needed, and added before the overlay', () => {
    const view = setup({ range: [100, 140] });
    const { api, element } = view;
    const markers = () => element.children.filter(child => child.className === 'interval-marker');
    const initial = markers();

    assert.equal(initial.length, 8);
    api.setRange([100, 200]);
    assert.deepEqual(markers().slice(0, 8), initial);
    assert.deepEqual(element.children.slice(0, 10), markers());
    assert.deepEqual(view.harness.labels(element), ['100', '110', '120', '130', '140', '150', '160', '170', '180', '190']);

    const reused = markers();

    api.setRange([120, 140]);
    assert.deepEqual(markers(), reused);
    assert.deepEqual(reused.map(marker => marker.hidden), [false, false, false, false, false, false, false, false, true, true]);
    assert.deepEqual(reused.slice(0, 3).map(marker => marker.style.values.get('--offset')), [0, 0.125, 0.25]);
});

test('a vertical wheel without Ctrl or Cmd scrolls the page', () => {
    const view = setup({ bounds: [0, 400] });

    assert.equal(view.harness.wheel(25, { deltaY: -100 }), false);
    assert.equal(view.harness.wheel(25, { deltaY: -100, shiftKey: true }), false);
    assert.equal(view.harness.wheel(25, { deltaY: -100, deltaX: 100 }), false);
    assert.deepEqual(view.calls, []);
});

test('a wheel with Ctrl or Cmd zooms around the pointer within bounds, markers keep the steps of the bounds', () => {
    const view = setup({
        range: [100, 200],
        bounds: [0, 400],
        segments: 10
    });
    const { api } = view;

    // Halves the range around 125
    assert.equal(view.harness.wheel(25, { deltaY: -Math.log(2) / 0.0015, ctrlKey: true }), true);
    assert.ok(Math.abs(api.state.range.start - 112.5) < 1e-9);
    assert.ok(Math.abs(api.state.range.end - 162.5) < 1e-9);
    assert.equal(api.state.segments.length, 11);
    assert.equal(api.state.segments.at(-1), api.state.range.end);
    assert.deepEqual(callTypes(view), ['range']);
    assert.deepEqual(view.harness.labels(view.element), ['115', '120', '125', '130', '135', '140', '145', '150', '155', '160']);

    assert.equal(view.harness.wheel(50, { deltaY: 2000, metaKey: true }), true);
    assert.deepEqual(api.state.range, { start: 0, end: 400 });
    assert.deepEqual(callTypes(view), ['range', 'range']);
});

test('a horizontal wheel pans within bounds', () => {
    const view = setup({ range: [0, 400], bounds: [0, 400] });
    const { api } = view;

    assert.equal(view.harness.wheel(50, { deltaX: 1000 }), true);
    assert.deepEqual(api.state.range, { start: 0, end: 400 });
    assert.deepEqual(view.calls, []);

    api.setRange([100, 140]);
    assert.equal(view.harness.wheel(50, { deltaY: 1, deltaX: 25 }), true);
    assert.deepEqual(view.calls, [{ type: 'range', range: { start: 110, end: 150 } }]);
    assert.deepEqual(view.harness.labels(view.element), ['110', '115', '120', '125', '130', '135', '140', '145']);
});

test('zoom stops at the precision of coordinates under a pixel', () => {
    const origin = 2 ** 40;
    const view = setup({ range: [origin, origin + 100], bounds: [origin, origin + 100] });

    for (let i = 0; i < 100; i++) {
        view.harness.wheel(50, { deltaY: -1000, ctrlKey: true });
    }

    const { start, end } = view.api.state.range;

    // Coordinates near 2^40 are 2^-12 apart, 100 pixels show one each
    assert.equal(end - start, 100 * 2 ** -12);
});

test('wheel is ignored without bounds, during a drag and outside of rulers', () => {
    const unbounded = setup();

    assert.equal(unbounded.harness.wheel(50, { deltaY: -100, ctrlKey: true }), false);
    assert.deepEqual(unbounded.calls, []);

    const view = setup({ bounds: [0, 400] });

    view.down(20);
    view.move(40);
    assert.equal(view.harness.wheel(50, { deltaY: -100, ctrlKey: true }), false);
    view.up(40);
    assert.deepEqual(view.api.state.range, { start: 100, end: 200 });

    view.harness.setActive(null);
    assert.equal(view.harness.wheel(50, { deltaY: -100, ctrlKey: true }), false);
    view.destroy();
    view.harness.setActive(view.element);
    assert.equal(view.harness.wheel(50, { deltaY: -100, ctrlKey: true }), false);
});

test('segments may depend on the range and the width of the ruler', () => {
    const calls = [];
    const segments = (range, width) => {
        calls.push([range, width]);

        return width / 25;
    };
    const view = setup({
        range: [100, 200],
        bounds: [0, 400],
        segments
    });
    const { api, element } = view;

    assert.deepEqual(calls, [[{ start: 100, end: 200 }, 100]]);
    assert.equal(api.state.segments.length, 5);

    // A width change resolves the segments on the next pointer move only
    element.width = 50;
    assert.equal(api.state.segments.length, 5);
    view.move(10);
    assert.deepEqual(calls.slice(1), [[{ start: 100, end: 200 }, 50]]);
    assert.deepEqual(api.state.segments, [100, 150, 200]);
    view.move(20);
    assert.equal(calls.length, 2);

    view.harness.wheel(0, { deltaX: 25 });
    assert.deepEqual(calls.slice(2), [[{ start: 150, end: 250 }, 50]]);
    api.setRange([300, 200]);
    assert.deepEqual(calls.slice(3), [[{ start: 200, end: 300 }, 50]]);
    assert.deepEqual(api.state.segments, [200, 250, 300]);
});
