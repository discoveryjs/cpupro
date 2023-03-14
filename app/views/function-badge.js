discovery.view.define('function-badge', {
    view: 'switch',
    data: '(function or $).marker("function")',
    whenData: true,
    content: [
        { when: 'object.module.package.type in ["script", "npm", "chrome-extension", "wasm", "node", "internals"]', content: {
            view: 'badge',
            className: ({ object: { module: { package: { type } } } }) => `function function-type_${type}`,
            data: `{
                ...,
                text: object | name,
                prefix: object.module | (package.type = "node" ? packageRelPath : package.name != "(script)" and package.name)
            }`
        } },
        { when: 'object.module.type = "script"', content: {
            view: 'badge',
            className: 'function function-type_script',
            data: `{
                ...,
                text: object | name,
                prefix: object.module.package | path and name != "(script)" and name
            }`
        } },
        { content: {
            view: 'badge',
            className: 'function',
            data: '{ ..., text: title }'
        } }
    ]
}, { tag: false });
