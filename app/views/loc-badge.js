discovery.view.define('loc-badge', {
    view: 'context',
    data: '(function or $).marker("function").object',
    content: {
        view: 'badge',
        className: 'function-loc',
        data: '{ ..., text: loc.match(/:\\d+:\\d+$/).matched[] }',
        whenData: 'text',
        content: ['html:text.split(/:/).join(`<span class="delim">:</span>`)'],
        postRender(el, _, data) {
            el.title = data.loc;
        }
    }
}, { tag: false });
