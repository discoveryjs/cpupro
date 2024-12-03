const { utils } = require('@discoveryjs/discovery');

discovery.view.define('update-on-timings-change', function(el, config, data, context) {
    const { timings = data, debounce, beforeContent, content } = config;
    let scheduledRender = null;
    const updateRender = () => {
        if (scheduledRender !== null) {
            return;
        }

        scheduledRender = requestAnimationFrame(() => {
            scheduledRender = null;

            el.replaceChildren();
            beforeContent?.(data, context);
            this.render(el, content, data, context);
        });
    };

    const unsubscribeSource = timings.subscribe(
        debounce
            ? utils.debounce(updateRender, debounce !== true ? debounce : { wait: 16, maxWait: 48 })
            : updateRender
    );

    el.onDestroy = () => {
        unsubscribeSource();
    };

    beforeContent?.(data, context);
    return this.render(el, content, data, context);
}, { tag: 'update-on-timings-change' });

class UpdateOnTimingsChange extends HTMLElement {
    connectedCallback() {
        this.onConnect?.();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy?.();
        this.onDestroy = null;
    }
}

customElements.define('update-on-timings-change', UpdateOnTimingsChange);
