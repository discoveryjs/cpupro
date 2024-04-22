discovery.view.define('module-badge', {
    view: 'badge',
    data: `(module or $).marker("module") |? {
        ...,
        text: object | packageRelPath or path or name,
        prefix: object.package | path and name != '(script)' and type not in ['node', 'deno'] and name,
        match: #.filter
    }`,
    whenData: true,
    className: '=`module module-type_${object.package | registry or type}`',
    content: 'text-match'
}, { tag: false });
