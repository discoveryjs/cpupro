discovery.view.define('code-disassemble-viewer', {
    view: 'tabs',
    name: 'mode',
    value: '=callFrame.hasSource() ? "getSessionSetting".callAction("cpupro-code-disassemble-viewer:mode", "code-to-source") : "raw"',
    onChange: '==> ? "setSessionSetting".callAction("cpupro-code-disassemble-viewer:mode", $)',
    tabs: [
        { value: 'code-to-source', text: 'Instructions' },
        // 'source-to-code',
        'raw'
    ],
    content: {
        view: 'switch',
        content: [
            { when: '#.mode="code-to-source"', content: 'code-disassemble-with-source' },
            // { when: '#.mode="source-to-code"', content: 'text:"TBD"' },
            { content: [
                {
                    view: 'source',
                    source: '=disassemble.raw'
                }
            ] }
        ]
    }
});

discovery.view.define('code-disassemble-with-source', {
    view: 'context',
    data: `{
        $blocks: assembleBlocks().({
            block: $,
            ranges: instructions.assembleRanges()
        });
        $commonAddressPrefixMap: $blocks.ranges
            .[type='pc']
            .(source[range[0]:range[1]])
            .commonPrefixMap(2);

        warnings: [
            not hasSource() ? 'Mapping to source code is not available, because the call frame has **no source code**',
            no positions and tier != 'Ignition' ? 'Mapping to source code is not available, because the call frame has **no position table**'
        ].[],
        $blocks.({
            block,
            ranges: ranges + ranges.(
                $source;
                $start: range[0];
                $end: range[1];

                type = 'pc' ? {
                    type: 'pc-common',
                    source,
                    range: [$start, $start + $commonAddressPrefixMap[source[$start:$end]]]
                } :
                type = 'hint' ? (
                    (source[$start:$end].match(/^\\((\\S+)\\s*@\\s*(\\d+)\\)$/) |? (
                        $maybePc: matched[1];
                        $maybePc in $commonAddressPrefixMap ? [
                            { type: 'pc', $source, range: [$start + 1, $start + 1 + $maybePc.size()] },
                            { type: 'pc-common', $source, range: [$start + 1, $start + 1 + $commonAddressPrefixMap[$maybePc]] },
                            { $offset: matched[2]; type: 'offset', $source, range: [$end - 1 - $offset.size(), $end - 1] },
                        ]
                    )) or
                    (source[$start:$end].match(/^\\(addr\\s+(\\S+?)\\)$/) |? (
                        $maybePc: matched[1];
                        $maybePcZ: $maybePc.replace(/0x0+/, '0x');
                        $s: $end - $maybePc.size() - 1;
                        $maybePc in $commonAddressPrefixMap or $maybePcZ in $commonAddressPrefixMap ? [
                            { type: 'pc', $source, range: [$s, $end - 1] },
                            { type: 'pc-common', $source, range: [$s, $s + ($maybePc in $commonAddressPrefixMap
                                ? $commonAddressPrefixMap[$maybePc]
                                : $commonAddressPrefixMap[$maybePcZ] + ($maybePc.size() - $maybePcZ.size())
                            )] }
                        ]
                    ))
                ) :
                type = 'param' ? (
                    $value: source[$start:$end];
                    $value in $commonAddressPrefixMap ? [
                        { type: 'pc', $source, range: [$start, $start + $value.size()] },
                        { type: 'pc-common', $source, range: [$start, $start + $commonAddressPrefixMap[$value]] }
                    ]
                )
            )
        })
    }`,
    content: [
        {
            view: 'list',
            className: 'view-code-disassemble-with-source__warning-list',
            data: 'warnings',
            whenData: true,
            item: { view: 'alert-warning', content: 'markdown' }
        },
        'view-code-disassemble-block-tree:blocks.assembleBlockTree(blocks[].block.code, => block)'
    ]
});

const blockListView = {
    view: 'list',
    className: 'view-code-disassemble-with-source__block-list',
    limit: false,
    data: 'is array ?: children',
    item: null
};
blockListView.item = [
    {
        view: 'block',
        className: 'block-reference',
        content: 'text:block.index | is number ? "B" + $ : ""'
    },
    'call-frame-source-point:block or location',
    {
        view: 'switch',
        content: [
            { when: 'inline', content: {
                view: 'block',
                className: 'view-code-disassemble-with-source__block-list__inlined-blocks',
                content: [
                    {
                        view: 'block',
                        className: 'inlined-header',
                        content: {
                            view: 'block',
                            className: 'inlined-header__content',
                            content: [
                                'call-frame-badge:inline.callFrame'
                                // 'badge{ text: inline.callFrame.name, href: inline.callFrame.marker().href }',
                                // 'text:" from "',
                                // 'module-badge:inline.callFrame'
                            ]
                        }
                    },
                    blockListView
                ]
            } },
            { content: [
                {
                    view: 'source',
                    className: 'call-frame-code-instructions',
                    source: '=block.instructions',
                    lineNum: false,
                    actionCopySource: false,
                    ranges: `=ranges.({
                        className: type + (type = 'command' ? (command ? ' def' : ' error') : ''),
                        source,
                        range,
                        tooltip: command and not param
                            ? {
                                className: 'code-disassemble-tooltip',
                                content: [
                                    { view: 'header', content: [
                                        { view: 'block', className: 'command-name', content: 'text:source[range[0]:range[1]]' },
                                        { view: 'comma-list', data: 'command.params', item: {
                                            view: 'block',
                                            className: 'param',
                                            content: 'text'
                                        } }
                                    ] },
                                    'md:command.description'
                                ]
                            }
                            : type = 'command' and @.block.compiler = "Ignition" ? {
                                className: 'code-disassemble-tooltip',
                                content: [
                                    { view: 'header', content: { view: 'block', className: 'command-name', content: 'text:source[range[0]:range[1]]' } },
                                    'text:"Unknown bytecode handler, create an issue in CPUpro bug tracker"'
                                ]
                            },
                        command
                    })`
                }
            ] }
        ]
    }
];

discovery.view.define('view-code-disassemble-block-tree', blockListView);
