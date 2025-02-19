discovery.view.define('package-badge', {
    view: 'badge',
    data: `module.package or package or $
        | marker("package")
        |? {
            ...,
            text: title,
            match: #.filter
        }`,
    whenData: true,
    className: '=`package subject-badge subject-badge_type__${object | registry or type}`',
    content: 'text-match',
    postRender(el, _, data) {
        const { registry, cdn, version } = data.object;

        if (cdn && cdn !== registry) {
            el.dataset.cdn = cdn;
        }

        if (version) {
            el.dataset.version = version;
        }
    }
}, { tag: false });

discovery.view.define('module-badge', {
    view: 'badge',
    data: `module or $
        | marker("module")
        |? {
            ...,
            text: object | packageRelPath or path or name,
            prefix: object.package | path and name != '(script)' and type not in ['node', 'deno'] and shortName,
            match: #.filter
        }`,
    whenData: true,
    className: '=`module subject-badge subject-badge_type__${object.package | registry or type}`',
    content: 'text-match',
    postRender(el, _, data) {
        const { registry, cdn } = data.object.package;

        if (cdn && cdn !== registry) {
            el.dataset.cdn = cdn;
        }
    }
}, { tag: false });

discovery.view.define('call-frame-badge', {
    view: 'badge',
    data: `callFrame or $
        | marker("call-frame")
        |? {
            $name: object.name;
            ...,
            text: $name,
            prefix: object.module |
                package.type in ["node", "deno"]
                    ? packageRelPath
                    : (package | name not in ["(script)", "(compiled script)", $name] and shortName),
            match: #.filter
        }`,
    whenData: true,
    className: '=`call-frame subject-badge subject-badge_type__${object.module.package | registry or type}`',
    content: 'text-match',
    postRender(el, _, data) {
        const { registry, cdn } = data.object.package;

        if (cdn && cdn !== registry) {
            el.dataset.cdn = cdn;
        }
    }
}, { tag: false });
