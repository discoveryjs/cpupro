import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

// A document focuses its body when a focused node is removed, a shadow root has no focused node then
const body = {};

function createSource() {
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
}

function loadViews(globals) {
    const { requestAnimationFrame, cancelAnimationFrame, debounce, query } = globals;
    const views = {};

    evaluateModule(new URL('./update-on-line-metrics-changes.js', import.meta.url), {
        discovery: {
            view: {
                define(name, render) {
                    views[name] = render;
                }
            },
            query
        },
        HTMLElement: class {},
        customElements: { define() {} },
        document: {
            body,
            createDocumentFragment: () => ({ children: [] })
        },
        requestAnimationFrame,
        cancelAnimationFrame,
        require: () => ({ utils: { debounce } })
    });

    return views;
}

async function createHarness(settings = {}) {
    const { multiple = false, blurred = null, ...options } = settings;
    const frames = new Map();
    const debounced = [];
    const pausedRenders = [];
    const root = { activeElement: null };
    const sources = Array.from({ length: multiple ? 2 : 1 }, createSource);
    const harness = {
        sources,
        root,
        renders: 0,
        commits: 0,
        debounceOptions: null,
        focusCalls: [],
        element: {
            children: [],
            getRootNode: () => root,
            contains: node => harness.element.children.includes(node),
            querySelectorAll: () => harness.element.children,
            replaceChildren(fragment) {
                if (harness.element.children.includes(root.activeElement)) {
                    root.activeElement = blurred;
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
            const pending = debounced.splice(0);

            for (let i = 0; i < pending.length; i++) {
                pending[i]();
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
        debounce(callback, options) {
            // Copy out of the module's realm so deepEqual compares plain values
            harness.debounceOptions = structuredClone(options);
            return () => debounced.push(callback);
        }
    });

    const host = {
        render(fragment) {
            const control = {
                id: ++harness.renders,
                focus(options) {
                    root.activeElement = control;
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

// Renders `line-metrics-value`; `results` gives the result of each query by its text, in the context of evaluation
async function createValueHarness(settings) {
    const { multiple = false, results, ...options } = settings;
    const sources = Array.from({ length: multiple ? 2 : 1 }, createSource);
    const harness = {
        sources,
        queries: [],
        element: {},
        data: {},
        context: { scope: 'section' },
        rendered: null
    };
    const views = loadViews({
        query(text, data, context) {
            harness.queries.push([text, data, context]);
            return results[text](context);
        }
    });
    const host = {
        render(el, content, data, context) {
            harness.rendered = { el, content, data, context };
        }
    };
    const config = {
        ...options,
        metrics: multiple ? sources : sources[0],
        content: 'list'
    };

    await views['line-metrics-value'].call(host, harness.element, config, harness.data, harness.context);

    return harness;
}

test.each([false, true])('coalesces notifications into one render per frame (multiple sources: %s)', async multiple => {
    const harness = await createHarness({ multiple });

    for (let i = 0; i < harness.sources.length; i++) {
        harness.sources[i].emit();
        harness.sources[i].emit();
    }
    await harness.flush();

    assert.equal(harness.renders, 2);
    assert.equal(harness.commits, 2);
    assert.equal(harness.element.children[0].id, 2);
});

test.each([
    [true, { wait: 16, maxWait: 48 }],
    [100, 100]
])('debounces notifications for debounce: %j with options %j', async (debounce, options) => {
    const harness = await createHarness({ debounce });

    assert.deepEqual(harness.debounceOptions, options);
});

test.each([false, true])(
    'stops rendering and unsubscribes from all sources on destroy (debounce: %s)',
    async debounce => {
        const harness = await createHarness({ multiple: true, debounce });

        for (let i = 0; i < harness.sources.length; i++) {
            assert.equal(harness.sources[i].listeners.size, 1);
        }

        harness.sources[0].emit();
        harness.element.onDestroy();
        await harness.flush();

        assert.equal(harness.renders, 1);
        for (let i = 0; i < harness.sources.length; i++) {
            assert.equal(harness.sources[i].listeners.size, 0);
        }
    }
);

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
    harness.sources[0].emit();
    await harness.flush();

    assert.equal(harness.root.activeElement, null);
    assert.deepEqual(harness.focusCalls, []);
});

test.each([
    ['a shadow root', null],
    ['a document', body]
])('restores focus lost in %s to the control at the same position without scrolling', async (_, blurred) => {
    const harness = await createHarness({ preserveFocus: true, blurred });

    harness.root.activeElement = harness.element.children[0];
    harness.sources[0].emit();
    await harness.flush();

    assert.equal(harness.root.activeElement, harness.element.children[0]);
    assert.equal(harness.root.activeElement.id, 2);
    assert.deepEqual(harness.focusCalls, [{ preventScroll: true }]);
});

const moveFocus = harness => {
    harness.root.activeElement = {};
};
const destroyView = harness => harness.element.onDestroy();

test.each([
    ['focus moves', moveFocus],
    ['the view is destroyed', destroyView]
])('does not restore focus when %s during rendering', async (_, interrupt) => {
    const harness = await createHarness({ preserveFocus: true });
    const resume = harness.pauseRender();

    harness.root.activeElement = harness.element.children[0];
    harness.sources[0].emit();
    await harness.flush();
    interrupt(harness);
    resume();
    await harness.flush();

    assert.deepEqual(harness.focusCalls, []);
});

test('renders its content with a value shared through the context of nested views', async () => {
    const harness = await createValueHarness({ name: 'totals', value: 'totals', results: { totals: () => 1 } });
    const { rendered } = harness;

    assert.equal(rendered.el, harness.element);
    assert.equal(rendered.content, 'list');
    assert.equal(rendered.data, harness.data);
    assert.equal(rendered.context.scope, 'section');
    assert.equal(rendered.context.totals.value, 1);
    assert.equal(harness.context.totals, undefined);
});

test.each([false, true])(
    'computes a value on the first read after any of its metrics changes, once for all readers (multiple sources: %s)',
    async multiple => {
        let computed = 0;
        const harness = await createValueHarness({
            multiple,
            name: 'totals',
            value: 'totals',
            results: { totals: () => ++computed }
        });
        const { totals } = harness.rendered.context;

        assert.equal(computed, 0);
        assert.equal(totals.value, 1);
        assert.equal(totals.value, 1);
        assert.deepEqual(harness.queries, [['totals', harness.data, harness.context]]);

        for (let i = 0; i < harness.sources.length; i++) {
            harness.sources[i].emit();
            assert.equal(computed, i + 1);
            assert.equal(totals.value, i + 2);
            assert.equal(totals.value, i + 2);
        }
    }
);

test.each([false, true])(
    'readers follow all metrics of a value until they unsubscribe, the view until destroyed (multiple sources: %s)',
    async multiple => {
        const harness = await createValueHarness({
            multiple,
            name: 'totals',
            value: 'totals',
            results: { totals: () => 1 }
        });
        let notified = 0;
        const unsubscribe = harness.rendered.context.totals.subscribe(() => notified++);

        for (let i = 0; i < harness.sources.length; i++) {
            harness.sources[i].emit();
        }
        assert.equal(notified, harness.sources.length);

        unsubscribe();
        for (let i = 0; i < harness.sources.length; i++) {
            assert.equal(harness.sources[i].listeners.size, 1);
        }

        harness.element.onDestroy();
        for (let i = 0; i < harness.sources.length; i++) {
            assert.equal(harness.sources[i].listeners.size, 0);
        }
    }
);

test('computes a value in a context given by a query at the time of computing', async () => {
    let window = 'first';
    const harness = await createValueHarness({
        name: 'bins',
        valueContext: 'window',
        value: 'bins',
        results: {
            window: () => ({ window }),
            bins: context => context.window
        }
    });
    const { bins } = harness.rendered.context;

    assert.equal(bins.value, 'first');
    window = 'second';
    assert.equal(bins.value, 'first');
    harness.sources[0].emit();
    assert.equal(bins.value, 'second');
    assert.deepEqual(harness.queries, [
        ['window', harness.data, harness.context],
        ['bins', harness.data, { window: 'first' }],
        ['window', harness.data, harness.context],
        ['bins', harness.data, { window: 'second' }]
    ]);
});
