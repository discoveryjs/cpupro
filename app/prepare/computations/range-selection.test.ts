import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { CoordinateFrame } from './coordinates.js';
import { RangeSelection, RangeView } from './range.js';

const space = { name: 'time', unit: 'us' };

test('a view rebases the request into its frame and clips only its coverage', () => {
    const frame = new CoordinateFrame(space, 2);
    const selection = new RangeSelection(space);
    const view = new RangeView(selection, frame, { start: 0, end: 11 });

    selection.setRanges([{ start: 12, end: 15 }, { start: 1, end: 3 }, { start: 5, end: 8 }]);
    const request = selection.ranges;

    assert.deepEqual(view.ranges, [{ start: -1, end: 1 }, { start: 3, end: 6 }, { start: 10, end: 13 }]);
    assert.deepEqual(view.coverage, [{ start: 0, end: 1 }, { start: 3, end: 6 }, { start: 10, end: 11 }]);

    frame.setOrigin(20);
    assert.deepEqual(view.coverage, []);
    assert.equal(selection.ranges, request);

    frame.setOrigin(2);
    view.setRange(1, 4);
    assert.deepEqual(selection.ranges, [{ start: 3, end: 6 }]);
    view.setRanges([]);
    assert.deepEqual(view.coverage, []);
    view.resetRange();
    assert.equal(selection.ranges, null);
    assert.deepEqual(view.coverage, [{ start: 0, end: 11 }]);
});

test('views of one selection are placed by their own frames', () => {
    const selection = new RangeSelection(space);
    const first = selection.view({ start: 0, end: 20 });
    const second = selection.view({ start: 0, end: 10 }, 15);

    assert.equal(first.frame.space, selection.space);
    assert.notEqual(first.frame, second.frame);

    selection.setRanges([{ start: 10, end: 18 }, { start: 20, end: 24 }]);
    assert.deepEqual(first.coverage, [{ start: 10, end: 18 }]);
    assert.deepEqual(second.coverage, [{ start: 0, end: 3 }, { start: 5, end: 9 }]);

    first.frame.setOrigin(100);
    assert.deepEqual(first.coverage, []);
    assert.deepEqual(second.coverage, [{ start: 0, end: 3 }, { start: 5, end: 9 }]);
});

test('a view notifies on changed requests and frame moves until unsubscribed', () => {
    const selection = new RangeSelection(space);
    const view = selection.view({ start: 0, end: 10 }, 10);
    let updates = 0;
    const stop = view.subscribe(() => updates++);

    selection.setRange(-10, 30);
    selection.setRanges([{ start: -10, end: 10 }, { start: 10, end: 30 }]);
    assert.equal(updates, 1);

    view.frame.setOrigin(20);
    assert.equal(updates, 2);
    assert.deepEqual(view.ranges, [{ start: -30, end: 10 }]);

    stop();
    stop();
    view.frame.setOrigin(50);
    selection.resetRange();
    assert.equal(updates, 2);
});

test('reports repeated requests separately from changes to the selected ranges', () => {
    const selection = new RangeSelection(space);
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

test('exposes live ranges, origin and extents to Jora and JSON', () => {
    const selection = new RangeSelection(space);
    const view = selection.view({ start: 0, end: 30 }, 100);
    const inspect = jora('{ requested: selection.ranges, origin: frame.origin, extent, resolvedExtent, ranges, coverage }');

    selection.setRanges([{ start: 95, end: 105 }, { start: 120, end: 140 }]);
    assert.deepEqual(inspect(view), {
        requested: [{ start: 95, end: 105 }, { start: 120, end: 140 }],
        origin: 100,
        extent: { start: 0, end: 30 },
        resolvedExtent: { start: 100, end: 130 },
        ranges: [{ start: -5, end: 5 }, { start: 20, end: 40 }],
        coverage: [{ start: 0, end: 5 }, { start: 20, end: 30 }]
    });

    view.frame.setOrigin(200);
    const snapshot = JSON.parse(JSON.stringify(view));

    assert.deepEqual(inspect(view).coverage, []);
    assert.equal(snapshot.frame.origin, 200);
    assert.deepEqual(snapshot.selection.ranges, selection.ranges);
    assert.deepEqual(snapshot.resolvedExtent, { start: 200, end: 230 });
    assert.deepEqual(snapshot.ranges, [{ start: -105, end: -95 }, { start: -80, end: -60 }]);
    assert.deepEqual(snapshot.coverage, []);
});

test('rejects a frame of another coordinate space', () => {
    const frame = new CoordinateFrame(space);
    const selection = new RangeSelection({ name: 'another-time', unit: 'us' });

    assert.throws(() => new RangeView(selection, frame, { start: 0, end: 10 }), /explicit mapping/);
});
