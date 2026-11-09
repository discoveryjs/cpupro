import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function loadViews({ requestAnimationFrame, cancelAnimationFrame, debounce, query = () => null }) {
    const views = {};

    evaluateModule(new URL('./update-on-line-metrics-changes.js', import.meta.url), {
        discovery: {
            view: { define(name, render) {
                views[name] = render;
            } },
            query
        },
        HTMLElement: class {},
        customElements: { define() {} },
        document: {
            body: {},
            createDocumentFragment: () => ({ children: [] })
        },
        requestAnimationFrame,
        cancelAnimationFrame,
        require: () => ({ utils: { debounce } })
    });

    return views;
}

async function createHarness({ multiple = false, ...options } = {}) {
    const frames = new Map();
    const debounced = [];
    const pausedRenders = [];
    const root = { activeElement: null };
    const sources = Array.from({ length: multiple ? 2 : 1 }, () => {
        const listeners = new Set();

        return {
            listeners,
            subscribe(callback) {
                listeners.add(callback);
                return () => listeners.delete(callback);
            },
            emit() {
                for (const callback of listeners) {
                    callback();
                }
            }
        };
    });
    const harness = {
        sources,
        root,
        renders: 0,
        commits: 0,
        focusCalls: [],
        element: {
            children: [],
            getRootNode: () => root,
            contains: node => harness.element.children.includes(node),
            querySelectorAll: () => harness.element.children,
            replaceChildren(fragment) {
                // A removed node loses focus, as in the DOM
                if (harness.element.children.includes(root.activeElement)) {
                    root.activeElement = null;
                }

                harness.element.children = fragment.children;
                harness.commits++;
            }
        },
        // The next render stays incomplete until the returned function is called
        pauseRender() {
            let resume;

            pausedRenders.push(new Promise(resolve => {
                resume = resolve;
            }));

            return resume;
        },
        async flush() {
            for (const callback of debounced.splice(0)) {
                callback();
            }

            for (const [id, callback] of frames) {
                frames.delete(id);
                callback();
            }

            await setImmediate();
        }
    };
    let lastFrame = 0;
    const views = loadViews({
        requestAnimationFrame(callback) {
            frames.set(++lastFrame, callback);
            return lastFrame;
        },
        cancelAnimationFrame(id) {
            frames.delete(id);
        },
        debounce: callback => () => debounced.push(callback)
    });

    const host = {
        render(fragment) {
            const control = {
                id: ++harness.renders,
                focus(options) {
                    root.activeElement = control;
                    // Copy out of the module's realm so deepEqual compares plain objects
                    harness.focusCalls.push({ ...options });
                }
            };

            fragment.children.push(control);

            return pausedRenders.shift() || Promise.resolve();
        }
    };
    const config = {
        ...options,
        metrics: multiple ? sources : sources[0],
        content: 'text'
    };

    await views['update-on-line-metrics-changes'].call(host, harness.element, config, {}, {});

    return harness;
}

test.each([false, true])('coalesces notifications into one render per frame (multiple sources: %s)', async multiple => {
    const harness = await createHarness({ multiple });

    for (const source of harness.sources) {
        source.emit();
        source.emit();
    }
    await harness.flush();

    assert.equal(harness.renders, 2);
    assert.equal(harness.commits, 2);
    assert.equal(harness.element.children[0].id, 2);
});

test.each([false, true])('stops rendering and unsubscribes from all sources on destroy (debounce: %s)', async debounce => {
    const harness = await createHarness({ multiple: true, debounce });

    for (const source of harness.sources) {
        assert.equal(source.listeners.size, 1);
    }

    harness.sources[0].emit();
    harness.element.onDestroy();
    await harness.flush();

    assert.equal(harness.renders, 1);
    for (const source of harness.sources) {
        assert.equal(source.listeners.size, 0);
    }
});

test('does not commit a render superseded before completion', async () => {
    const harness = await createHarness();
    const resumeSuperseded = harness.pauseRender();

    harness.sources[0].emit();
    await harness.flush();
    harness.sources[0].emit();
    await harness.flush();
    resumeSuperseded();
    await harness.flush();

    assert.equal(harness.renders, 3);
    assert.equal(harness.element.children[0].id, 3);
});

test('leaves focus alone unless preservation is requested', async () => {
    const harness = await createHarness();

    harness.root.activeElement = harness.element.children[0];
    harness.element.getRootNode = () => assert.fail('Focus preservation must be opt-in');
    harness.sources[0].emit();
    await harness.flush();

    assert.equal(harness.root.activeElement, null);
    assert.deepEqual(harness.focusCalls, []);
});

test('restores focus to the control at the same position without scrolling', async () => {
    const harness = await createHarness({ preserveFocus: true });

    harness.root.activeElement = harness.element.children[0];
    harness.sources[0].emit();
    await harness.flush();

    assert.equal(harness.root.activeElement, harness.element.children[0]);
    assert.equal(harness.root.activeElement.id, 2);
    assert.deepEqual(harness.focusCalls, [{ preventScroll: true }]);
});

test.each(['focus moved', 'destroyed'])('does not restore focus when %s during rendering', async reason => {
    const harness = await createHarness({ preserveFocus: true });
    const resume = harness.pauseRender();

    harness.root.activeElement = harness.element.children[0];
    harness.sources[0].emit();
    await harness.flush();

    if (reason === 'focus moved') {
        harness.root.activeElement = {};
    } else {
        harness.element.onDestroy();
    }

    resume();
    await harness.flush();

    assert.deepEqual(harness.focusCalls, []);
});

test('shares a value computed once per change of its metrics among nested readers', async () => {
    const listeners = new Set();
    const source = {
        subscribe(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    };
    const queries = [];
    const views = loadViews({
        requestAnimationFrame() {},
        cancelAnimationFrame() {},
        debounce: callback => callback,
        query: (query, data, context) => {
            queries.push([query, data, context]);
            return queries.length;
        }
    });
    const element = {};
    const data = {};
    const context = { scope: 'section' };
    let rendered = null;
    const host = {
        render(el, content, renderData, renderContext) {
            rendered = { el, content, data: renderData, context: renderContext };
        }
    };

    await views['line-metrics-value'].call(host, element, { name: 'totals', metrics: source, value: 'query', content: 'list' }, data, context);

    const { totals } = rendered.context;

    assert.equal(rendered.el, element);
    assert.equal(rendered.content, 'list');
    assert.equal(rendered.data, data);
    assert.equal(rendered.context.scope, 'section');
    assert.deepEqual(queries, []);
    assert.equal(totals.value, 1);
    assert.equal(totals.value, 1);
    assert.deepEqual(queries, [['query', data, context]]);

    // Readers follow the value as metrics, it's computed again on the first read after a change
    let notified = 0;
    const unsubscribe = totals.subscribe(() => notified++);

    for (const callback of [...listeners]) {
        callback();
    }

    assert.equal(notified, 1);
    assert.equal(queries.length, 1);
    assert.equal(totals.value, 2);
    assert.equal(totals.value, 2);
    assert.equal(queries.length, 2);

    unsubscribe();
    element.onDestroy();
    assert.equal(listeners.size, 0);
});

test('a line metrics value may be computed in a context given by a query at the time of computing', async () => {
    const listeners = new Set();
    const source = {
        subscribe(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    };
    const queries = [];
    let window = 'first';
    const views = loadViews({
        requestAnimationFrame() {},
        cancelAnimationFrame() {},
        debounce: callback => callback,
        query: (query, data, context) => {
            queries.push([query, data, context]);
            return query === 'window' ? { window } : [query, context.window];
        }
    });
    const data = {};
    const context = { scope: 'section' };
    let rendered = null;
    const host = {
        render(el, content, renderData, renderContext) {
            rendered = renderContext;
        }
    };

    await views['line-metrics-value'].call(host, {}, { name: 'bins', metrics: source, valueContext: 'window', value: 'bins', content: 'list' }, data, context);
    assert.deepEqual(rendered.bins.value, ['bins', 'first']);
    assert.deepEqual(queries, [['window', data, context], ['bins', data, { window: 'first' }]]);

    window = 'second';
    assert.deepEqual(rendered.bins.value, ['bins', 'first']);

    for (const callback of [...listeners]) {
        callback();
    }

    assert.deepEqual(rendered.bins.value, ['bins', 'second']);
    assert.equal(queries.length, 4);
});
