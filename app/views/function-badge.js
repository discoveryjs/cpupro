discovery.view.define('function-badge', {
    view: 'badge',
    data: `(function or $).marker("function") |? {
        $name: object.name;
        ...,
        text: $name,
        prefix: object.module |
            package.type in ["node", "deno"]
                ? packageRelPath
                : (package | name not in ["(script)", "(compiled script)", $name] and name),
        match: #.filter
    }`,
    whenData: true,
    className: '=`function function-type_${object.module.package | registry or type}`',
    content: 'text-match'
}, { tag: false });
