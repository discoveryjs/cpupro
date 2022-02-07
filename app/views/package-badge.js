discovery.view.define('package-badge', {
    view: 'switch',
    data: '(module.package or package or $).marker("package")',
    whenData: true,
    content: [
        { content: {
            view: 'badge',
            className: ({ object: { type } }) => `package package-type_${type}`,
            data: '{ ..., text: title }'
        } }
    ]
}, { tag: false });
