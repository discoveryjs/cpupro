discovery.view.define('loc-badge', {
    view: 'badge',
    className: 'function-loc',
    data: '(function or $).marker("function").object |? { ..., text: loc.match(/:\\d+:\\d+$/).matched[] }',
    whenData: 'text',
    content: 'html:text.split(/:/).join(`<span class="delim">:</span>`)',
    postRender(el, _, data) {
        el.title = data.loc;
    }
}, { tag: false });
