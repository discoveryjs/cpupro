discovery.view.define('loc-badge', {
    view: 'badge',
    className: 'function-loc',
    data: 'function or $ | marker("function").object |? { ..., text: loc }',
    whenData: 'text',
    content: 'html:text.split(/:/).join(`<span class="delim">:</span>`)',
    postRender(el, _, data) {
        // Support a injectable custom function to provide custom action to open in editor
        window.handleOpenInEditor?.(el, data.module.path + data.text);
    }
}, { tag: false });
