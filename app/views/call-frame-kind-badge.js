discovery.view.define('call-frame-kind-badge', {
    view: 'badge',
    className: '=`call-frame-kind ${$}`',
    data: 'kind or $ | is string and not match(/[^a-z\\-]/i)?',
    whenData: true
}, { tag: false });
