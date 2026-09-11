const { utils } = require('@discoveryjs/discovery');

discovery.view.define('update-on-line-metrics-changes', function(el, config, data, context) {
    const { metrics = data, debounce, beforeContent, content } = config;
    let scheduledRender = null;
    let destroyed = false;
    const updateRender = () => {
        if (destroyed || scheduledRender !== null) {
            return;
        }

        scheduledRender = requestAnimationFrame(() => {
            scheduledRender = null;

            el.replaceChildren();
            beforeContent?.(data, context);
            this.render(el, content, data, context);
        });
    };

    const unsubscribeSource = metrics.subscribe(
        debounce
            ? utils.debounce(updateRender, debounce !== true ? debounce : { wait: 16, maxWait: 48 })
            : updateRender
    );

    el.onDestroy = () => {
        destroyed = true;
        unsubscribeSource();
        if (scheduledRender !== null) {
            cancelAnimationFrame(scheduledRender);
            scheduledRender = null;
        }
    };

    beforeContent?.(data, context);
    return this.render(el, content, data, context);
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
