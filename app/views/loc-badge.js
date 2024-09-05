discovery.view.define('loc-badge', {
    view: 'badge',
    className: 'function-loc',
    data: 'function or $ | marker("function").object |? { ..., text: loc }',
    whenData: 'text and text != ":0:0"',
    content: 'html:text.replace(/:/, `<span class="delim">:</span>`)'
}, { tag: false });
