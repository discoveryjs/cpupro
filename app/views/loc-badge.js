discovery.view.define('loc-badge', {
    view: 'context',
    data: '(function or $).marker("function").object',
    content: {
        view: 'badge',
        whenData: 'loc',
        className: 'function-loc',
        content: ['html:loc.match(/:\\d+:\\d+$/).matched[].split(/:/).join(`<span class="delim">:</span>`)'],
        data: '{ ..., text: loc.match(/:\\d+:\\d+$/).matched[] }',
        postRender(el, _, data) {
            el.title = data.loc;
        }
    }
}, { tag: false });
