import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';

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
