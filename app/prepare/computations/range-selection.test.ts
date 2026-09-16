import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { CoordinateFrame } from './coordinates.js';
import { RangeSelection, RangeView } from './range.js';
import { Population, PopulationFiltered } from './population.js';
import { applyRangeToPopulation } from '../lines/range.js';

test('exposes live requested ranges, frame origin and resolved extent to Jora and object inspection', () => {
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    const view = selection.view({ start: 0, end: 30 }, 100);
    const inspect = jora(`{
        requested: selection.ranges,
        origin: frame.origin,
        extent,
        resolvedExtent,
        ranges,
        coverage
    }`);
    assert.equal(inspect(view).requested, null);
    selection.setRanges([{ start: 95, end: 105 }, { start: 120, end: 140 }]);
    assert.deepEqual(inspect(view), {
        requested: [{ start: 95, end: 105 }, { start: 120, end: 140 }],
        origin: 100,
        extent: { start: 0, end: 30 },
        resolvedExtent: { start: 100, end: 130 },
        ranges: [{ start: -5, end: 5 }, { start: 20, end: 40 }],
        coverage: [{ start: 0, end: 5 }, { start: 20, end: 30 }]
    });
    assert.ok(Object.keys(selection).includes('ranges'));
    assert.ok(Object.keys(view.frame).includes('origin'));
    assert.ok(['ranges', 'coverage', 'resolvedExtent'].every(key => Object.keys(view).includes(key)));
    const request = selection.ranges;
    view.frame.setOrigin(200);
    assert.equal(inspect(view).origin, 200);
    assert.deepEqual(inspect(view).resolvedExtent, { start: 200, end: 230 });
    assert.deepEqual(inspect(view).coverage, []);
    assert.equal(inspect(view).requested, request);
    const snapshot = JSON.parse(JSON.stringify(view));
    assert.equal(snapshot.frame.origin, 200);
    assert.deepEqual(snapshot.selection.ranges, request);
    assert.deepEqual(snapshot.resolvedExtent, { start: 200, end: 230 });
    selection.setRanges([]);
    assert.deepEqual(inspect(view).requested, []);
    selection.resetRange();
    assert.equal(inspect(view).requested, null);
});

test('independent presentations of one base population do not compete for scope authority', () => {
    const frame = new CoordinateFrame({ name: 'time', unit: 'us' });
    const firstScope = new RangeSelection(frame.space);
    const secondScope = new RangeSelection(frame.space);
    const base = new Population(new Uint32Array([0, 1]), new Uint32Array([10, 20]));
    const first = new PopulationFiltered(base);
    const second = new PopulationFiltered(base);
    const firstView = new RangeView(firstScope, frame, { start: 0, end: 30 });
    const secondView = new RangeView(secondScope, frame, { start: 0, end: 30 });
    const stopFirst = applyRangeToPopulation(firstView, first);
    const stopSecond = applyRangeToPopulation(secondView, second);
    firstScope.setRanges([{ start: 0, end: 5 }, { start: 15, end: 20 }]);
    assert.deepEqual([...first.values], [5, 5]);
    assert.deepEqual(second.values, base.values);
    secondScope.setRange(10, 15);
    assert.deepEqual([...second.values], [0, 5]);
    assert.deepEqual([...first.values], [5, 5]);
    assert.deepEqual([...base.values], [10, 20]);
    stopFirst();
    stopSecond();
});

test('normalizes requested ranges without clipping and unsubscribes from selection and local frame', () => {
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    const view = selection.view({ start: 0, end: 10 }, 10);
    const local = view.frame;
    let updates = 0;
    const stop = view.subscribe(() => updates++);
    selection.setRange(-10, 30);
    selection.setRanges([{ start: -10, end: 10 }, { start: 10, end: 30 }]);
    assert.equal(updates, 1);
    const requested = selection.ranges;
    local.setOrigin(20);
    assert.equal(updates, 2);
    assert.equal(selection.ranges, requested);
    assert.deepEqual(view.ranges, [{ start: -30, end: 10 }]);
    assert.deepEqual(view.coverage, [{ start: 0, end: 10 }]);
    stop();
    stop();
    local.setOrigin(50);
    selection.resetRange();
    assert.equal(updates, 2);
});

test('creates independently placed views of one request without a source frame', () => {
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    const first = selection.view({ start: 0, end: 20 });
    const second = selection.view({ start: 0, end: 10 }, 15);
    assert.equal(first.selection, selection);
    assert.equal(second.selection, selection);
    assert.equal(first.frame.space, selection.space);
    assert.notEqual(first.frame, second.frame);
    assert.equal(first.frame.origin, 0);
    selection.setRanges([{ start: 10, end: 18 }, { start: 20, end: 24 }]);
    const request = selection.ranges;
    assert.deepEqual(first.coverage, [{ start: 10, end: 18 }]);
    assert.deepEqual(second.coverage, [{ start: 0, end: 3 }, { start: 5, end: 9 }]);
    first.frame.setOrigin(100);
    assert.deepEqual(first.coverage, []);
    assert.equal(selection.ranges, request);
    assert.deepEqual(second.coverage, [{ start: 0, end: 3 }, { start: 5, end: 9 }]);
    second.setRange(1, 4);
    assert.deepEqual(selection.ranges, [{ start: 16, end: 19 }]);
});

test('reports repeated requests separately from changes to the selected ranges', () => {
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    let changes = 0;
    let updates = 0;
    selection.subscribe(() => changes++);
    const stop = selection.updates.subscribe(() => updates++);
    selection.setRange(1, 5);
    const ranges = selection.ranges;
    selection.setRange(1, 5);
    assert.equal(selection.ranges, ranges);
    assert.equal(changes, 1);
    assert.equal(updates, 2);
    stop();
    selection.resetRange();
    assert.equal(changes, 2);
    assert.equal(updates, 2);
});
