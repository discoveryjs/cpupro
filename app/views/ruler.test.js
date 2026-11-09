import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { queryToConfig } from '@discoveryjs/discovery/lib/core/utils/query-to-config.js';
import jora from 'jora';
import usage from './ruler.usage.js';

test('showcase details compile using Discovery configuration syntax', () => {
    const examples = [usage.demo, ...usage.examples.map(example => example.demo)].flat();
    for (const example of examples) {
        if (example.details?.startsWith('struct{')) {
            const config = queryToConfig('struct', example.details.slice('struct'.length));
            assert.equal(config.view, 'struct');
            assert.doesNotThrow(() => jora(config.data));
        }
    }
});

test('renders numeric labels without a profile and accepts an external label formatter', () => {
    const harness = createRulerHarness();
    const element = harness.createElement('ruler');
    harness.render(element, { range: 100 }, null, {});
    const markers = element.children.filter(child => child.className === 'interval-marker');
    assert.deepEqual(markers.map(marker => marker.dataset.title), ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90']);
    const formatted = harness.createElement('ruler');
    harness.render(formatted, { range: 100, formatLabel: (value, range, step) => `${value}/${range.end}/${step}` }, null, {});
    assert.deepEqual(formatted.children.filter(child => child.className === 'interval-marker').map(marker => marker.dataset.title), [
        '0/100/10', '10/100/10', '20/100/10', '30/100/10', '40/100/10', '50/100/10', '60/100/10', '70/100/10', '80/100/10', '90/100/10'
    ]);
});

function setup(options = {}, render) {
    const harness = createRulerHarness(render);
    const element = harness.createElement('ruler');
    element.width = 100;
    harness.createElement('parent').appendChild(element);
    const calls = [];
    const data = { data: true };
    const context = { context: true };
    let api;
    let cleanups = 0;
    const record = type => (value, input, scope) => {
        assert.equal(value, api);
        assert.equal(input, data);
        assert.equal(scope, context);
        calls.push({ type, selection: value.state.selection });
    };
    harness.render(element, {
        range: [100, 200],
        onChange: record('change'), onCommit: record('commit'),
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
            return () => cleanups++;
        }
    }, data, context);
    harness.setActive(element);
    return {
        harness, element, api, calls,
        move: x => harness.move({ x, y: 5 }),
        down: (x, target = element) => harness.pointerDown(x, target),
        up: x => harness.pointerUp(x),
        handle: trigger => harness.selectionHandle(element, trigger),
        cleanups: () => cleanups,
        destroy: () => harness.destroy(element)
    };
}

test.each([false, true])('previews and commits in the configured selection format, multiple=%s', multiple => {
    const view = setup({ range: [-1, 1], multiple });
    const { api, calls } = view;
    view.move(25);
    assert.equal(api.state.selection, null);
    view.down(25);
    view.move(62.5);
    assert.deepEqual(api.state.selection, multiple ? [{ start: -0.5, end: 0.25 }] : { start: -0.5, end: 0.25 });
    assert.equal(calls.length, 1);
    view.up(62.5);
    assert.deepEqual(calls.map(call => call.type), ['change', 'commit']);
    api.setSelection(multiple ? [{ start: -2, end: 3 }] : { start: -2, end: 3 });
    assert.equal(calls.length, 2);
    assert.deepEqual(Object.keys(api.state), ['range', 'length', 'segments', 'selection']);
    view.down(90);
    view.up(90);
    assert.equal(api.state.selection, null);
    assert.deepEqual(calls.slice(-2).map(call => call.type), ['change', 'commit']);
    view.destroy();
});

test.each([
    { segments: null },
    { segments: 10 },
    { segments: [100, 110, 140, 200] }
])('highlights the pointer side when creating a selection inside a segment, segments=$segments', ({ segments }) => {
    const view = setup({ segments });
    view.down(25);
    for (const [pointer, active] of [[70, 'finish'], [10, 'start'], [27, 'finish'], [23, 'start']]) {
        view.move(pointer);
        assert.equal(view.element.dataset.activeTrigger, active);
        assert.equal(view.element.dataset.state, 'selecting');
    }
    view.up(23);
    assert.equal(view.element.dataset.activeTrigger, 'none');
    view.destroy();
});

test('keeps hover and selected-interval details separate from selection and hides gap tooltips', () => {
    let scope;
    let shown = 0;
    const view = setup({ segments: 10, multiple: true, details: 'struct' }, (el, details, data, context) => {
        scope = context;
        shown++;
    });
    const segments = view.api.state.segments;
    view.move(25);
    view.harness.showTooltip();
    assert.deepEqual(scope.detail, { start: 120, end: 130 });
    assert.equal(scope.ruler.selection, null);
    view.api.setSelection([{ start: 90, end: 125 }, { start: 160, end: 180 }]);
    view.move(10);
    view.harness.showTooltip();
    assert.equal(scope.detail.start, 100);
    assert.equal(scope.detail.end, 125);
    assert.equal(view.api.state.selection[0].start, 90);
    view.move(50);
    view.harness.showTooltip();
    assert.equal(shown, 2);
    view.move(70);
    view.harness.showTooltip();
    assert.deepEqual({ ...scope.detail }, { start: 160, end: 180 });
    assert.equal(view.api.state.segments, segments);
    view.api.setSelection([{ start: 10, end: 20 }, { start: 220, end: 230 }]);
    assert.equal(view.element.querySelector('.view-ruler__ranges').children.length, 0);
    view.api.setSelection([]);
    assert.deepEqual(view.api.state.selection, []);
    view.destroy();
});

test('delivers the latest hovered target with its interval and respects competing tooltips', () => {
    const renders = [];
    const view = setup({ segments: 10, details: 'struct' }, (el, details, data, context) => {
        renders.push(context);
    });
    const first = view.element.parentNode.appendChild(view.harness.createElement('first'));
    const second = view.element.parentNode.appendChild(view.harness.createElement('second'));

    view.harness.setActive(view.element, first);
    view.move(25);
    view.harness.setActive(view.element, second);
    view.move(25);
    view.harness.showTooltip();

    assert.equal(renders.length, 1);
    assert.ok(renders[0].detailTarget === second, 'Latest hovered section is retained');
    assert.deepEqual(renders[0].detail, { start: 120, end: 130 });

    view.api.setSelection({ start: 120, end: 130 });
    const overlay = view.element.querySelector('.view-ruler__selection-overlay-mover');
    view.harness.setActive(view.element, overlay, second);
    view.move(25);
    view.harness.showTooltip();
    assert.ok(renders[1].detailTarget === second, 'Selection overlay retains the underlying section');

    second.closest = () => second;
    view.harness.setActive(view.element, second);
    view.move(25);
    view.harness.showTooltip();
    assert.equal(renders.length, 2);
    view.destroy();
});

test.each([null, 10])('moves and resizes without rebuilding segments, segments=%s', segments => {
    const view = setup({ segments, selection: { start: 123, end: 167 } });
    const boundaries = view.api.state.segments;
    const mover = view.element.querySelector('.view-ruler__selection-overlay-mover');
    view.down(30, mover);
    view.move(45);
    view.up(45);
    const moved = view.api.state.selection;
    assert.equal(moved.end - moved.start, 44);
    const handle = view.handle('finish');
    view.down(moved.end - 100, handle);
    view.move(99);
    view.up(99);
    assert.equal(view.api.state.selection.start, moved.start);
    assert.ok(view.api.state.selection.end > moved.end);
    assert.equal(view.api.state.segments, boundaries);
    assert.equal(view.calls.filter(call => call.type === 'commit').length, 2);
    view.destroy();
});

test.each([null, 100])('jumps across the original resize anchor after reaching the minimum, segments=%s', segments => {
    const view = setup({ range: 100, segments, selection: { start: 10, end: 40 } });
    const handle = view.handle('start');
    view.down(12, handle);
    for (const pointer of [39, 39.5, 40]) {
        view.move(pointer + 2);
        assert.deepEqual(view.api.state.selection, { start: 39, end: 40 });
    }
    view.move(42.5);
    assert.deepEqual(view.api.state.selection, { start: 40, end: 41 });
    view.move(82);
    view.up(82);
    assert.deepEqual(view.api.state.selection, { start: 40, end: 80 });
    view.destroy();
});

test.each(['pointercancel', 'keydown'])('cancels preview and restores multiple selection without commit: %s', event => {
    const original = [{ start: 110, end: 120 }, { start: 180, end: 190 }];
    const view = setup({ multiple: true, selection: original });
    view.down(40);
    view.move(65);
    view.harness.globalEvents.get(event)({ key: 'Escape', preventDefault() {} });
    view.up(65);
    assert.deepEqual(view.api.state.selection, original);
    assert.deepEqual(view.calls.map(call => call.type), ['change', 'change']);
    assert.equal(view.element.dataset.state, 'selected');
    view.destroy();
});

test.each([50, 200])('uses one CSS pixel for continuous pointer resize and retains committed coordinates, width=%s', width => {
    const view = setup({ range: [-1, 1], selection: { start: -0.5, end: 0.5 } });
    view.element.width = width;
    const handle = view.handle('finish');
    view.down(width * 0.75 + 2, handle);
    view.move(width * 0.25 + 2);
    const minimum = { start: -0.5, end: -0.5 + 2 / width };
    assert.deepEqual(view.api.state.selection, minimum);
    view.up(width * 0.25 + 2);
    assert.deepEqual(view.calls.at(-1), { type: 'commit', selection: minimum });
    view.element.width = width / 2;
    view.move(width / 4);
    assert.deepEqual(view.api.state.selection, minimum);
    for (const selection of [{ start: 0, end: 0 }, { start: 0, end: 0.0001 }]) {
        view.api.setSelection(selection);
        view.move(width / 4);
        assert.deepEqual(view.api.state.selection, selection);
    }
    view.destroy();
});

test.each([25, 100])('retains a one-pixel selection when a new continuous drag returns to its anchor=%s', anchor => {
    const view = setup();
    view.down(anchor);
    view.move(anchor - 10);
    view.move(anchor);
    view.up(anchor);
    const minimum = { start: 100 + anchor - 1, end: 100 + anchor };
    assert.deepEqual(view.api.state.selection, minimum);
    assert.deepEqual(view.calls.at(-1), { type: 'commit', selection: minimum });
    view.destroy();
});

test.each([null, 10])('cancels a minimum resize and restores the exact external range, segments=%s', segments => {
    const selection = { start: 120, end: 120.001 };
    const view = setup({ segments, selection });
    const handle = view.handle('finish');
    view.down(selection.end - 100, handle);
    view.move(20);
    assert.ok(view.api.state.selection.end > selection.end);
    view.harness.globalEvents.get('pointercancel')();
    assert.deepEqual(view.api.state.selection, selection);
    assert.equal(view.calls.some(call => call.type === 'commit'), false);
    view.destroy();
});

test('external replacement cancels an obsolete drag, and teardown disables updates exactly once', () => {
    const view = setup({ onInit: api => api.setSelection({ start: 110, end: 120 }) });
    assert.deepEqual(view.api.state.selection, { start: 110, end: 120 });
    assert.equal(view.calls.length, 0);
    view.down(40);
    view.move(65);
    view.api.setSelection({ start: 180, end: 190 });
    view.up(65);
    assert.deepEqual(view.api.state.selection, { start: 180, end: 190 });
    assert.equal(view.calls.length, 1);
    view.down(30);
    view.move(50);
    view.destroy();
    view.destroy();
    const selection = view.api.state.selection;
    view.api.setSelection(null);
    view.up(50);
    assert.equal(view.api.state.selection, selection);
    assert.equal(view.cleanups(), 1);
    assert.equal(view.calls.some(call => call.type === 'commit'), false);
});

test.each([[false, false], [true, false], [false, 'top']])('grid and labels are independent: %s, %s', (grid, labels) => {
    const view = setup({ range: [-0.5, 0.5], grid, labels });
    assert.equal(view.element.dataset.grid, String(grid));
    assert.equal(view.element.dataset.labels, labels || 'none');
    assert.equal(view.element.children.some(child => child.className === 'interval-marker'), Boolean(grid || labels));
    view.destroy();
});

const markers = element => element.children.filter(child => child.className === 'interval-marker');
const markerTitles = element => markers(element)
    .filter(marker => !marker.hidden)
    .map(marker => marker.dataset.title);

test('wheel zooms around the pointer and pans within bounds, a vertical wheel scrolls the page', () => {
    const view = setup({ range: [100, 200], bounds: [0, 400], segments: 10 });
    const { api, calls, harness, element } = view;

    assert.equal(harness.wheel(25, { deltaY: -100 }), false);
    assert.equal(harness.wheel(25, { deltaY: -100, shiftKey: true }), false);
    assert.equal(harness.wheel(25, { deltaY: -100, deltaX: 100 }), false);
    assert.equal(calls.length, 0);

    assert.equal(harness.wheel(25, { deltaY: -Math.log(2) / 0.0015, ctrlKey: true }), true);
    assert.ok(Math.abs(api.state.range.start - 112.5) < 1e-9 && Math.abs(api.state.range.end - 162.5) < 1e-9);
    assert.equal(api.state.segments.length, 11);
    assert.equal(api.state.segments.at(-1), api.state.range.end);
    assert.deepEqual(calls.map(call => call.type), ['range']);
    // Markers keep the steps from the bounds start rather than from the zoomed range start
    assert.deepEqual(markerTitles(element), ['115', '120', '125', '130', '135', '140', '145', '150', '155', '160']);

    assert.equal(harness.wheel(50, { deltaY: 2000, metaKey: true }), true);
    assert.deepEqual(api.state.range, { start: 0, end: 400 });

    assert.equal(harness.wheel(50, { deltaY: 0, deltaX: 1000 }), true);
    assert.deepEqual(api.state.range, { start: 0, end: 400 });
    assert.equal(calls.length, 2);

    api.setRange([100, 140]);
    assert.equal(harness.wheel(50, { deltaY: 1, deltaX: 25 }), true);
    assert.deepEqual(api.state.range, { start: 110, end: 150 });
    assert.equal(calls.length, 3);
    assert.deepEqual(markerTitles(element), ['110', '115', '120', '125', '130', '135', '140', '145']);
    view.destroy();
});

test('zoom stops at the precision of coordinates under a pixel', () => {
    const origin = 2 ** 40;
    const view = setup({ range: [origin, origin + 100], bounds: [origin, origin + 100] });

    for (let i = 0; i < 100; i++) {
        view.harness.wheel(50, { deltaY: -1000, ctrlKey: true });
    }

    const { start, end } = view.api.state.range;

    assert.ok(end - start >= 100 * Number.EPSILON * origin);
    assert.ok(end - start < 200 * Number.EPSILON * origin);
    view.destroy();
});

test('wheel is ignored without bounds, during a drag and outside of rulers', () => {
    const unbounded = setup();

    assert.equal(unbounded.harness.wheel(50, { deltaY: -100, ctrlKey: true }), false);
    assert.equal(unbounded.calls.length, 0);
    unbounded.destroy();

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

test('setRange updates reused markers and keeps the selection without notifications', () => {
    const view = setup({ selection: { start: 120, end: 130 } });
    const { api, calls, element } = view;

    assert.equal(element.style.values.get('--selection-start'), 0.2);
    const intervals = markers(element);

    api.setRange({ start: 120, end: 140 });
    assert.deepEqual(api.state.range, { start: 120, end: 140 });
    assert.equal(api.state.length, 20);
    assert.deepEqual(api.state.selection, { start: 120, end: 130 });
    assert.deepEqual(markerTitles(element), ['120', '122.5', '125', '127.5', '130', '132.5', '135', '137.5']);
    assert.deepEqual(markers(element), intervals);
    assert.deepEqual(intervals.map(marker => marker.hidden), [...new Array(8).fill(false), true, true]);
    assert.deepEqual(intervals.slice(0, 3).map(marker => marker.style.values.get('--offset')), [0, 0.125, 0.25]);
    assert.equal(element.children.indexOf(element.querySelector('.view-ruler__selection-overlay')), 10);
    api.setRange({ start: 120, end: 140 });
    assert.equal(element.style.values.get('--selection-start'), 0);
    assert.equal(element.style.values.get('--selection-end'), 0.5);
    api.setRange([140, 120]);
    api.setRange({ start: 120, end: 160 });
    assert.deepEqual(api.state.range, { start: 120, end: 160 });
    assert.equal(element.style.values.get('--selection-end'), 0.25);
    assert.equal(calls.length, 0);
    view.destroy();
    api.setRange([0, 1]);
    assert.deepEqual(api.state.range, { start: 120, end: 160 });
});

test('markers are added before the overlay only when more of them are needed', () => {
    const view = setup({ range: [100, 140] });
    const { api, element } = view;
    const intervals = markers(element);

    assert.equal(intervals.length, 8);
    api.setRange([100, 200]);
    assert.equal(markers(element).length, 10);
    assert.deepEqual(markers(element).slice(0, 8), intervals);
    assert.deepEqual(element.children.slice(0, 10), markers(element));
    assert.deepEqual(markerTitles(element), ['100', '110', '120', '130', '140', '150', '160', '170', '180', '190']);
    view.destroy();
});

test('segments may depend on the range and the width of the ruler', () => {
    const calls = [];
    const view = setup({ range: [100, 200], bounds: [0, 400], segments(range, width) {
        calls.push([range, width]);

        return width / 25;
    } });
    const { api, harness, element } = view;

    assert.deepEqual(calls, [[{ start: 100, end: 200 }, 100]]);
    assert.equal(api.state.segments.length, 5);

    // A width change resolves the segments on the next pointer move only
    element.width = 50;
    assert.equal(api.state.segments.length, 5);
    view.move(10);
    assert.deepEqual(calls.slice(1), [[{ start: 100, end: 200 }, 50]]);
    assert.deepEqual(Array.from(api.state.segments), [100, 150, 200]);
    view.move(20);
    assert.equal(calls.length, 2);

    harness.wheel(0, { deltaX: 25 });
    assert.deepEqual(calls.slice(2), [[{ start: 150, end: 250 }, 50]]);
    api.setRange([300, 200]);
    assert.deepEqual(calls.slice(3), [[{ start: 200, end: 300 }, 50]]);
    assert.deepEqual(Array.from(api.state.segments), [200, 250, 300]);
    view.destroy();
});
