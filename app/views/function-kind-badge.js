discovery.view.define('function-kind-badge', {
    view: 'badge',
    className: '=`function-kind ${$}`',
    data: 'kind or $ | is string and not match(/[^a-z\\-]/i)?',
    whenData: true
}, { tag: false });
