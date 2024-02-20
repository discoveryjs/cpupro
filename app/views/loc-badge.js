discovery.view.define('loc-badge', {
    view: 'context',
    data: '(function or $).marker("function").object',
    content: {
        view: 'badge',
        whenData: 'loc',
        className: 'function-loc',
        data: '{ ..., text: loc.match(/:\\d+:\\d+$/).matched[] }',
        content: ['html:text.split(/:/).join(`<span class="delim">:</span>`)'],
        postRender(el, _, data) {
            el.title = data.loc;
        }
    }
}, { tag: false });
