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
