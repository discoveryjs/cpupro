discovery.view.define('call-frame-loc-badge', {
    view: 'badge',
    className: 'call-frame-loc',
    data: `
        callFrame or $
        | marker("call-frame").object
        | loc and loc != ':0:0' ? { ..., text: loc }
    `,
    whenData: true,
    content: 'html:text.replace(/:/, `<span class="delim">:</span>`)'
}, { tag: false });
