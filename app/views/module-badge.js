discovery.view.define('module-badge', {
    view: 'switch',
    data: '(module or $).marker("module")',
    whenData: true,
    content: [
        { when: 'object.package.type in ["script", "npm", "chrome-extension", "wasm", "node", "electron"]', content: {
            view: 'badge',
            className: ({ object: { package: { type } } }) => `module module-type_${type}`,
            content: 'text-match:{ text, match: #.filter }',
            data: `{
                ...,
                text: object | packageRelPath or path or name,
                prefix: object.package | not name ~= /^\\(/ and name
            }`
        } },
        { when: 'object.type = "script"', content: {
            view: 'badge',
            className: 'module module-type_script',
            content: 'text-match:{ text, match: #.filter }',
            data: `{
                ...,
                text: object | packageRelPath or path or name,
                prefix: object.package | path and name != "(script)" and name
            }`
        } },
        { content: {
            view: 'badge',
            className: 'module',
            content: 'text-match:{ text, match: #.filter }',
            data: '{ ..., text: title }'
        } }
    ]
}, { tag: false });
