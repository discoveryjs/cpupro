discovery.view.define('code-positions-table-viewer', {
    view: 'tabs',
    name: 'mode',
    value: '="getSessionSetting".callAction("cpupro-call-frame-codes-table-positions-details:mode", "table")',
    onChange: '==> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-positions-details:mode", $)',
    tabs: [
        'table',
        'raw'
    ],
    content: {
        view: 'switch',
        content: [
            { when: '#.mode="table"', content: {
                view: 'table',
                data: 'positions.({ ..., entry: inline is number ? `C${code}O${offset}I${inline}` : `C${code}O${offset}` })',
                cols: [
                    { header: '#', data: 'index' },
                    { header: 'Entry', sorting: 'entry ascN', content: 'text-match{ text: entry, match: /\\D+/g }' },
                    { header: 'C', data: 'code' },
                    { header: 'O', data: 'offset' },
                    { header: 'I', data: 'inline' },
                    { header: 'Size', data: 'size' }
                ]
            } },
            { content: {
                view: 'block',
                className: 'code-raw-table-block',
                content: [
                    {
                        view: 'source',
                        data: 'code.positions',
                        lineNum: false,
                        ranges: `=
                            $match: ($rx, $kind) => @.match($rx, true).({ className: $kind, range: [start, end] });
                            /C\\d+/.$match('def') +
                            /O\\d+/.$match('') +
                            /I\\d+/.$match('ref') +
                            /C[^C]+/.$match('entry')
                        `
                    }
                ]
            } }
        ]
    }
});
