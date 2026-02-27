discovery.view.define('appbar', [
    { view: 'block', className: 'appbar-logo', content: 'text:"CPUpro"' },
    { view: 'block', className: 'appbar-content', content: [
        {
            view: 'toggle-group',
            data: '#.data.profiles.lines.type',
            // whenData: 'size() > 1',
            value: '=#.primaryLineType',
            onChange: '==>"selectPrimaryLine".callAction($)'
        },
        {
            view: 'block',
            className: 'appbar-profile-name',
            content: 'text:#.datasets[].resource | type = "file" ? name : "Untitled dataset"'
        }
    ] }
]);
