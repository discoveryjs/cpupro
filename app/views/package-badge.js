discovery.view.define('package-badge', {
    view: 'badge',
    data: `(module.package or package or $).marker("package") |? {
        ...,
        text: title,
        match: #.filter
    }`,
    whenData: true,
    className: '=`package package-type_${object | registry or type}`',
    content: 'text-match'
}, { tag: false });
