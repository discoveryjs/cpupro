discovery.view.define('loc-badge', {
    view: 'badge',
    className: 'function-loc',
    data: 'function or $ | marker("function").object |? { ..., text: loc }',
    whenData: 'text',
    content: 'html:text.split(/:/).join(`<span class="delim">:</span>`)'
}, { tag: false });
