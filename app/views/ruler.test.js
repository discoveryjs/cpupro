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
    harness.render(formatted, { range: 100, formatLabel: (value, range) => `${value}/${range.end}` }, null, {});
    assert.deepEqual(formatted.children.filter(child => child.className === 'interval-marker').map(marker => marker.dataset.title), [
        '0/100', '10/100', '20/100', '30/100', '40/100', '50/100', '60/100', '70/100', '80/100', '90/100'
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
    const move = x => harness.move({ x, y: 5 });
    const down = (x, target = element) => {
        move(x);
        harness.hostEvents.get('pointerdown')({ buttons: 1, pointerId: 1, x, y: 5, target });
    };
    const up = x => harness.globalEvents.get('pointerup')({ pointerId: 1, x, y: 5 });
    return { harness, element, api, calls, move, down, up, cleanups: () => cleanups,
        destroy: () => element.children.find(child => child.tag === 'destroy-ruler').onDestroy()
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

test.each([null, 10])('moves and resizes without rebuilding segments, segments=%s', segments => {
    const view = setup({ segments, selection: { start: 123, end: 167 } });
    const boundaries = view.api.state.segments;
    const mover = view.element.querySelector('.view-ruler__selection-overlay-mover');
    view.down(30, mover);
    view.move(45);
    view.up(45);
    const moved = view.api.state.selection;
    assert.equal(moved.end - moved.start, 44);
    const handle = mover.children.find(child => child.dataset.trigger === 'finish');
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
    const handle = view.element.querySelector('.view-ruler__selection-overlay-mover')
        .children.find(child => child.dataset.trigger === 'start');
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
    const handle = view.element.querySelector('.view-ruler__selection-overlay-mover')
        .children.find(child => child.dataset.trigger === 'finish');
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
    const handle = view.element.querySelector('.view-ruler__selection-overlay-mover')
        .children.find(child => child.dataset.trigger === 'finish');
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
