import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';

function createHarness(debounce = false, { multiple = false, preserveFocus = false } = {}) {
    let renderView;
    let unsubscribed = 0;
    let frames = 0;
    let renders = 0;
    let replacements = 0;
    let controls = [];
    let completion = Promise.resolve();
    const root = { activeElement: null };
    const focusOptions = [];
    const callbacks = new Map();
    const delayed = [];
    const sources = Array.from({ length: multiple ? 2 : 1 }, () => {
        const listeners = new Set();
        return {
            subscribe(callback) {
                listeners.add(callback);
                return () => {
                    listeners.delete(callback);
                    unsubscribed++;
                };
            },
            emit() {
                listeners.forEach(callback => callback());
            }
        };
    });
    runInNewContext(readFileSync(new URL('./update-on-line-metrics-changes.js', import.meta.url), 'utf8'), {
        discovery: { view: { define(name, render) {
            renderView = render;
        } } },
        HTMLElement: class {},
        customElements: { define() {} },
        document: { body: {} },
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
    const element = {
        getRootNode: () => root,
        contains: control => controls.includes(control),
        querySelectorAll: () => controls,
        replaceChildren() {
            replacements++;
            if (controls.includes(root.activeElement)) {
                root.activeElement = null;
            }
            controls = [];
        }
    };
    renderView.call({ render() {
        renders++;
        const control = {
            focus(options) {
                root.activeElement = control;
                focusOptions.push(options);
            }
        };
        controls = [control];
        return completion;
    } }, element, { metrics: multiple ? sources : sources[0], debounce, preserveFocus, content: 'text' }, {}, {});
    return {
        element, sources, root, focusOptions,
        get controls() {
            return controls;
        },
        set completion(value) {
            completion = value;
        },
        update: () => sources[0].emit(),
        flush() {
            const pending = [];
            for (const callback of delayed.splice(0)) {
                callback();
            }
            for (const [id, callback] of callbacks) {
                callbacks.delete(id);
                pending.push(callback());
            }
            return Promise.all(pending);
        },
        counts: () => ({ renders, replacements, unsubscribed: unsubscribed === sources.length })
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

test('coalesces multiple sources and unsubscribes from all of them', async () => {
    const harness = createHarness(false, { multiple: true });
    harness.sources.forEach(source => {
        source.emit();
        source.emit();
    });
    await harness.flush();
    assert.deepEqual(harness.counts(), { renders: 2, replacements: 1, unsubscribed: false });

    harness.sources[0].emit();
    harness.element.onDestroy();
    harness.sources.forEach(source => source.emit());
    await harness.flush();
    assert.deepEqual(harness.counts(), { renders: 2, replacements: 1, unsubscribed: true });
});

test('does not inspect focus when preservation is disabled', async () => {
    const harness = createHarness();
    harness.element.getRootNode = () => assert.fail('Focus preservation must be opt-in');
    harness.update();
    await harness.flush();

    assert.deepEqual(harness.counts(), { renders: 2, replacements: 1, unsubscribed: false });
});

test.each([false, true])('restores control focus only when requested (preserveFocus=%s)', async preserveFocus => {
    const harness = createHarness(false, { preserveFocus });
    harness.root.activeElement = harness.controls[0];
    harness.update();
    await harness.flush();

    assert.equal(harness.root.activeElement, preserveFocus ? harness.controls[0] : null);
    assert.equal(harness.focusOptions.length, preserveFocus ? 1 : 0);
    if (preserveFocus) {
        assert.equal(harness.focusOptions[0].preventScroll, true);
    }
});

test.each(['focus moved', 'destroyed'])('does not restore focus after %s during rendering', async reason => {
    const harness = createHarness(false, { preserveFocus: true });
    let finish;
    harness.completion = new Promise(resolve => {
        finish = resolve;
    });
    harness.root.activeElement = harness.controls[0];
    harness.update();
    const rendering = harness.flush();

    if (reason === 'focus moved') {
        harness.root.activeElement = {};
    } else {
        harness.element.onDestroy();
    }

    finish();
    await rendering;
    assert.equal(harness.focusOptions.length, 0);
});
