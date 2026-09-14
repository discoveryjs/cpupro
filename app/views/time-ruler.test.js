import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { RangeSelection } from '../prepare/computations/range.js';

test('projects a common range to a local ruler and writes gestures back without feedback', () => {
    const harness = createRulerHarness();
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    const manager = selection.view({ start: 0, end: 1001 }, 1000);
    selection.setRange(1123, 1567);
    let updates = 0;
    manager.subscribe(() => updates++);
    let state;
    const element = harness.createElement('ruler');
    harness.createElement('parent').appendChild(element);
    harness.render(element, {
        duration: 1001, segments: 10, rangeManager: manager,
        onInit(value) {
            state = value;
        }
    }, {}, {});
    assert.equal(state.timeStart, 123);
    assert.equal(state.timeEnd, 567);
    assert.equal(updates, 0);
    selection.setRange(900, 1200);
    assert.equal(state.timeStart, 0);
    assert.equal(state.timeEnd, 200);
    assert.equal(selection.ranges[0].start, 900);
    assert.equal(updates, 1);
    selection.setRange(2100, 2200);
    assert.equal(state.timeStart, 1001);
    assert.equal(state.timeEnd, 1001);
    assert.equal(selection.ranges[0].end, 2200);
    selection.setRange(1123, 1567);
    harness.setActive(element);
    harness.move({ x: 120, y: 30 });
    harness.hostEvents.get('pointerdown')({
        buttons: 1, pointerId: 1, x: 120, y: 30,
        target: element.querySelector('.view-time-ruler__selection-overlay-mover')
    });
    harness.move({ x: 165, y: 30 });
    assert.equal(selection.ranges[0].start, state.timeStart + 1000);
    assert.equal(selection.ranges[0].end, state.timeEnd + 1000);
    assert.equal(selection.ranges[0].end - selection.ranges[0].start, 444);
    assert.equal(updates, 4);
    manager.resetRange();
    assert.equal(state.timeStart, null);
    element.children.find(child => child.tag === 'destroy-time-ruler').onDestroy();
    const previousStart = state.timeStart;
    selection.setRange(1000, 1010);
    assert.equal(state.timeStart, previousStart);
});

test('renders disjoint local intervals and follows frame movement without changing the request', () => {
    const harness = createRulerHarness();
    const selection = new RangeSelection({ name: 'time', unit: 'us' });
    const manager = selection.view({ start: 0, end: 100 }, 100);
    const local = manager.frame;
    selection.setRanges([{ start: 90, end: 120 }, { start: 150, end: 160 }]);
    const requested = selection.ranges;
    let state;
    const element = harness.createElement('ruler');
    harness.createElement('parent').appendChild(element);
    harness.render(element, {
        duration: 100, rangeManager: manager,
        onInit(value) {
            state = value;
        }
    }, {}, {});
    const intervals = element.querySelector('.view-time-ruler__ranges');
    assert.equal(element.dataset.multipleRanges, 'true');
    assert.equal(intervals.children.length, 2);
    local.setOrigin(130);
    assert.equal(intervals.children.length, 1);
    assert.equal(selection.ranges, requested);
    manager.setRange(20, 40);
    assert.equal(element.dataset.multipleRanges, 'false');
    assert.equal(state.timeStart, 20);
    local.setOrigin(140);
    assert.equal(state.timeStart, 10);
    assert.equal(state.timeEnd, 30);
    element.children.find(child => child.tag === 'destroy-time-ruler').onDestroy();
    local.setOrigin(150);
    assert.equal(state.timeStart, 10);
});

test.each([10, undefined])('synchronizes selection silently and cleans up an active drag, segments=%s', segments => {
    const harness = createRulerHarness();
    const listeners = new Set();
    const manager = {
        rangeStart: 123,
        rangeEnd: 567,
        updates: 0,
        subscribe(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
        setRange(start, end) {
            this.updates++;
            this.rangeStart = start;
            this.rangeEnd = end;
            for (const callback of listeners) {
                callback();
            }
        }
    };
    let changes = 0;
    let state;
    const element = harness.createElement('ruler');
    harness.createElement('parent').appendChild(element);
    harness.render(element, {
        duration: 1001,
        segments,
        rangeManager: manager,
        selectionStart: manager.rangeStart,
        selectionEnd: manager.rangeEnd,
        onInit(value) {
            state = value;
        },
        onChange(value) {
            changes++;
            manager.setRange(value.timeStart, value.timeEnd);
        }
    }, {}, {});

    assert.equal(state.timeStart, 123);
    assert.equal(state.timeEnd, 567);
    manager.setRange(137, 581);
    assert.equal(changes, 0);
    assert.equal(manager.updates, 1);
    assert.equal(state.timeStart, 137);
    assert.equal(state.timeEnd, 581);

    harness.setActive(element);
    harness.move({ x: 120, y: 30 });
    harness.hostEvents.get('pointerdown')({
        buttons: 1, pointerId: 1, x: 120, y: 30,
        target: element.querySelector('.view-time-ruler__selection-overlay-mover')
    });
    harness.move({ x: 165, y: 30 });
    assert.equal(state.timeEnd - state.timeStart, 444);
    assert.equal(changes, 1);
    assert.equal(manager.updates, 2);
    assert.equal(element.dataset.state, 'selecting');
    harness.move({ x: 170, y: 30 });
    assert.equal(state.timeEnd - state.timeStart, 444);
    assert.equal(manager.updates, changes + 1);

    element.children.find(child => child.tag === 'destroy-time-ruler').onDestroy();
    harness.setActive(null);
    assert.equal(listeners.size, 0);
    assert.doesNotThrow(() => harness.move({ x: 180, y: 30 }));
    assert.doesNotThrow(() => harness.globalEvents.get('pointerup')());
    assert.doesNotThrow(() => element.listeners.get('pointerup')());
});
