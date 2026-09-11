import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';

function createHarness(debounce = false) {
    let renderView;
    let update;
    let unsubscribed = false;
    let frames = 0;
    let renders = 0;
    let replacements = 0;
    const callbacks = new Map();
    const delayed = [];
    const metrics = {
        subscribe(callback) {
            update = callback;
            return () => {
                unsubscribed = true;
            };
        }
    };
    runInNewContext(readFileSync(new URL('./update-on-line-metrics-changes.js', import.meta.url), 'utf8'), {
        discovery: { view: { define(name, render) {
            renderView = render;
        } } },
        HTMLElement: class {},
        customElements: { define() {} },
        requestAnimationFrame(callback) {
            callbacks.set(++frames, callback);
            return frames;
        },
        cancelAnimationFrame(id) {
            callbacks.delete(id);
        },
        require() {
            return { utils: { debounce: callback => () => delayed.push(callback) } };
        }
    });
    const element = { replaceChildren() {
        replacements++;
    } };
    renderView.call({ render() {
        renders++;
    } }, element, { metrics, debounce, content: 'text' }, {}, {});
    return {
        element,
        update: () => update(),
        flush() {
            for (const callback of delayed.splice(0)) {
                callback();
            }
            for (const [id, callback] of callbacks) {
                callbacks.delete(id);
                callback();
            }
        },
        counts: () => ({ renders, replacements, unsubscribed })
    };
}

test('coalesces repeated metric notifications into one live render', () => {
    const harness = createHarness();
    harness.update();
    harness.update();
    harness.flush();
    assert.deepEqual(harness.counts(), { renders: 2, replacements: 1, unsubscribed: false });
});

test.each([false, true])('does not render after destruction with debounce=%s', debounce => {
    const harness = createHarness(debounce);
    harness.update();
    harness.element.onDestroy();
    harness.flush();
    assert.deepEqual(harness.counts(), { renders: 1, replacements: 0, unsubscribed: true });
});
