discovery.view.define('appbar', [
    { view: 'block', className: 'appbar__logo', content: 'text:"CPUpro"' },
    { view: 'block', className: 'appbar__content', content: [
        {
            view: 'toggle-group',
            data: '#.data.profiles.lines.type',
            // whenData: 'size() > 1',
            value: '=#.primaryLineType',
            onChange: '==>"selectPrimaryLine".callAction($)'
        },
        {
            view: 'toggle-group',
            data: '#.data.profiles.lines.trees.kind',
            // whenData: 'size() > 1',
            value: '=#.primaryTreeKind',
            onChange: '==>"selectPrimaryTree".callAction($)'
        },
        {
            view: 'block',
            className: 'appbar__profile-name',
            content: 'text:#.datasets[].resource | type = "file" ? name : "Untitled dataset"'
        }
    ] }
]);
