const { utils } = require('@discoveryjs/discovery');

discovery.view.define('draft-timings-related', function(el, config, data, context) {
    const { source = data, debounce, content } = config;
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

    const unsubscribeSource = source.on(
        debounce
            ? utils.debounce(updateRender, debounce !== true ? debounce : { wait: 16, maxWait: 32 })
            : updateRender
    );

    el.onDestroy = () => {
        unsubscribeSource();
    };

    return this.render(el, content, data, context);
}, { tag: 'draft-timings-related' });

class DrafTimingsRelated extends HTMLElement {
    connectedCallback() {
        this.onConnect?.();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy?.();
        this.onDestroy = null;
    }
}

customElements.define('draft-timings-related', DrafTimingsRelated);
