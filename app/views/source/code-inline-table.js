discovery.view.define('code-inline-table-viewer', {
    view: 'tabs',
    name: 'mode',
    value: '="getSessionSetting".callAction("cpupro-call-frame-codes-table-inlined-details:mode", "tree")',
    onChange: '==> ? "setSessionSetting".callAction("cpupro-call-frame-codes-table-inlined-details:mode", $)',
    tabs: [
        'tree',
        'table',
        'raw'
    ],
    content: {
        view: 'switch',
        data: `{
            $ownerCallFrame: callFrame;
            $fns;
            $size;

            index: callFrameCodes.indexOf($),
            code: $,
            positions.parsePositions($size),
            inlined.parseInlined($fns).({
                ...,
                $ownerCallFrame
            })
        }`,
        content: [
            { when: '#.mode="tree"', content: {
                view: 'tree',
                className: 'inlining-tree',
                limitLines: false,
                expanded: 20,
                data: 'inlined.tree(=>parent).sort(value.offset asc)',
                children: 'children.sort(value.offset asc)',
                item: [
                    'call-frame-badge:value.callFrame',
                    {
                        view: 'badge',
                        className: 'source-loc',
                        data: `
                            $callFrame: parent ? parent.value.callFrame : value.ownerCallFrame;
                            value
                                | offset.offsetToLineColumn($callFrame)
                                | is object ? \`:\${line}:\${column}\`
                        `,
                        whenData: true,
                        content: 'html:replace(/:/, `<span class=\"delim\">:</span>`)'
                    },
                    'call-frame-source-point{ when: no parent, data: value }'
                ]
            } },
            { when: '#.mode="table"', content: {
                view: 'table',
                limit: false,
                data: 'inlined.({ ..., entry: parent is number ? `F${fn}O${offset}I${parent}` : `F${fn}O${offset}` })',
                cols: [
                    { header: '#', data: 'index' },
                    { header: 'Entry', sorting: 'entry ascN', content: 'text-match{ text: entry, match: /\\D+/g }' },
                    { header: 'F (call frame)', sorting: 'callFrame.name ascN', content: 'call-frame-badge:callFrame' },
                    { header: 'O', data: 'offset' },
                    { header: 'I', data: 'parent' }
                ]
            } },
            { content: {
                view: 'block',
                className: 'code-raw-table-block',
                content: [
                    {
                        view: 'source',
                        data: 'code.inlined',
                        lineNum: false,
                        ranges: `=
                            $match: ($rx, $kind) => @.match($rx, true).({ className: $kind, range: [start, end] });
                            /F\\d+/.$match('def') +
                            /O\\d+/.$match('') +
                            /I\\d+/.$match('ref') +
                            /F[^F]+/.$match('entry')
                        `
                    },
                    {
                        view: 'struct',
                        expanded: 1,
                        data: 'code.fns'
                    }
                ]
            } }
        ]
    }
});
