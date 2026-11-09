const { utils } = require('@discoveryjs/discovery');

function withPreservedFocus(el, render, canRestoreFocus) {
    const root = el.getRootNode();
    const activeElement = root.activeElement;
    const controls = 'input, button, select, textarea, [tabindex]';
    const focusIndex = el.contains(activeElement)
        ? [...el.querySelectorAll(controls)].indexOf(activeElement)
        : -1;

    return render(() => {
        if (canRestoreFocus()) {
            if (focusIndex !== -1 && (!root.activeElement || root.activeElement === document.body)) {
                el.querySelectorAll(controls)[focusIndex]?.focus({ preventScroll: true });
            }
        }
    });
}

discovery.view.define('update-on-line-metrics-changes', function(el, config, data, context) {
    const { metrics = data, debounce, content, preserveFocus = false } = config;
    let scheduledRender = null;
    let destroyed = false;
    let lastRender = null;
    const renderContent = (onRender = () => {}) => {
        const buffer = document.createDocumentFragment();
        const renderPromise = this.render(buffer, content, data, context);

        lastRender = renderPromise;

        return renderPromise.finally(() => {
            if (lastRender === renderPromise) {
                lastRender = null;
                el.replaceChildren(buffer);
                onRender();
            }
        });
    };
    const updateRender = () => {
        if (destroyed || scheduledRender !== null) {
            return;
        }

        scheduledRender = requestAnimationFrame(() => {
            scheduledRender = null;

            if (preserveFocus) {
                withPreservedFocus(el, renderContent, () => !destroyed);
            } else {
                renderContent();
            }
        });
    };

    const onUpdate = debounce
        ? utils.debounce(updateRender, debounce !== true ? debounce : { wait: 16, maxWait: 48 })
        : updateRender;
    const unsubscribeSources = (Array.isArray(metrics) ? metrics : [metrics])
        .map(source => source.subscribe(onUpdate));

    el.onDestroy = () => {
        destroyed = true;
        unsubscribeSources.forEach(unsubscribe => unsubscribe());

        if (scheduledRender !== null) {
            cancelAnimationFrame(scheduledRender);
            scheduledRender = null;
        }
    };

    return renderContent();
}, { tag: 'update-on-line-metrics-changes' });

// Shares a value computed from line metrics with nested views: they read it as `#.<name>.value` and follow its
// changes as metrics of `update-on-line-metrics-changes`. The value query is evaluated on the first read after
// a change, once for all readers, e.g. viewport totals for the labels of every row of a section. A valueContext
// query gives the context of the value query at that time, e.g. of the line window histograms are computed for
discovery.view.define('line-metrics-value', function(el, config, data, context) {
    const { name, metrics = data, value, valueContext, content } = config;
    const sources = Array.isArray(metrics) ? metrics : [metrics];
    let current = null;
    let stale = true;
    const shared = {
        get value() {
            if (stale) {
                current = discovery.query(value, data, valueContext ? discovery.query(valueContext, data, context) : context);
                stale = false;
            }

            return current;
        },
        subscribe(fn) {
            const unsubscribeSources = sources.map(source => source.subscribe(fn));

            return () => unsubscribeSources.forEach(unsubscribe => unsubscribe());
        }
    };

    el.onDestroy = shared.subscribe(() => {
        stale = true;
    });

    return this.render(el, content, data, { ...context, [name]: shared });
}, { tag: 'update-on-line-metrics-changes' });

class UpdateOnLineValuesChanges extends HTMLElement {
    connectedCallback() {
        this.onConnect?.();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy?.();
        this.onDestroy = null;
    }
}

customElements.define('update-on-line-metrics-changes', UpdateOnLineValuesChanges);
