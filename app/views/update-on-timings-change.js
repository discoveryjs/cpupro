const { utils } = require('@discoveryjs/discovery');

discovery.view.define('update-on-timings-change', function(el, config, data, context) {
    const { timings = data, debounce, content } = config;
    let scheduledRender = null;
    const updateRender = () => {
        if (scheduledRender) {
            return;
        }

        scheduledRender = requestAnimationFrame(() => {
            scheduledRender = null;

            el.textContent = '';
            this.render(el, content, data, context);
        });
    };

    const unsubscribeSource = timings.on(
        debounce
            ? utils.debounce(updateRender, debounce !== true ? debounce : { wait: 16, maxWait: 32 })
            : updateRender
    );

    el.onDestroy = () => {
        unsubscribeSource();
    };

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
