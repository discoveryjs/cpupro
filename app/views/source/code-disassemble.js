discovery.view.define('code-disassemble-viewer', {
    view: 'tabs',
    name: 'mode',
    value: '=callFrame.hasSource() ? "getSessionSetting".callAction("cpupro-code-disassemble-viewer:mode", "code-blocks") : "raw"',
    onChange: '==> ? "setSessionSetting".callAction("cpupro-code-disassemble-viewer:mode", $)',
    tabs: [
        { value: 'code-blocks', text: 'Code blocks' },
        { value: 'source-to-code', text: 'Source to blocks' },
        'raw'
    ],
    content: {
        view: 'switch',
        content: [
            { when: '#.mode="code-blocks"', content: 'code-disassemble-with-source' },
            { when: '#.mode="source-to-code"', content: 'code-disassemble-source-to-blocks' },
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
    data: 'disassembleBlocksAndRanges()',
    content: [
        {
            view: 'list',
            className: 'view-code-disassemble-with-source__warning-list',
            data: 'warnings',
            whenData: true,
            item: { view: 'alert-warning', content: 'markdown' }
        },
        'code-disassemble-block-tree:blocks.disassembleBlockTree(blocks[].block.code, => block)'
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
        content: 'text:block.id or "" | $ = "" or $[0] = "B" ?: $[0].toUpperCase()'
    },
    {
        view: 'switch',
        content: [
            {
                when: 'block.id or "" | $ = "" or $[0] = "B"',
                content: 'call-frame-source-point:block ? (block | { callFrame: originCallFrame, offset: originOffset }) : location'
            },
            { content: {
                view: 'block',
                className: 'special-block-header',
                content: 'text:block.id'
            } }
        ]
    },
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
                        marker,
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
                                    'text:"Unknown bytecode handler, fill an issue in CPUpro bug tracker"'
                                ]
                            },
                        command
                    })`
                }
            ] }
        ]
    }
];

discovery.view.define('code-disassemble-block-tree', blockListView);

discovery.view.define('code-disassemble-source-to-blocks', function(el, props, data, context) {
    const renderData = discovery.query(`{
        $blockAndRanges: disassembleBlocksAndRanges();

        code: $,
        ...$blockAndRanges,
        blockByOffset: $blockAndRanges.blocks.group(=>block.offset)
            .({ offset: key, blocks: value })
            .[offset is number and offset >= 0]
            .sort(offset asc)
    }`, data, context);
    let blocksEl = null;

    this.render(el, [
        {
            view: 'list',
            className: 'view-code-disassemble-with-source__warning-list',
            data: 'warnings',
            whenData: true,
            item: { view: 'alert-warning', content: 'markdown' }
        },
        {
            view: 'source',
            data: `code.callFrame | {
                $source: script.source;
                $sourceSliceStart: $source.lastIndexOf('\\n', start) + 1;
                $sourceSliceEnd: $source.indexOf('\\n', end) | $ != -1 ?: $source.size();
                $sourceSlice: $source[$sourceSliceStart:$sourceSliceEnd].replace(/\\n$/, '');
                $line: line or 1;
                $markerContent: [
                    'text:blocks.size()',
                    {
                        view: 'block',
                        className: 'inlined-count',
                        data: 'blocks.count(=> block.inlineId > -1?)',
                        whenData: true,
                        content: 'text'
                    }
                ];
                $tooltip: {
                    className: 'source-to-block-tooltip',
                    content: [
                        {
                            view: 'text',
                            data: \`{
                                blockText: blocks.size() + (blocks.size() != 1 ? " blocks are" : " block is"),
                                inlinedText: blocks.[block.inlineId > -1] |? \\\`, \\\${size()} of which belong to \\\${block.originCallFrame.size() + 1 | $ > 1 ? $ + ' other inlined functions' : 'another inlined function'}\\\` : ''
                            }\`,
                            text: '=\\\`\\\${blockText} associated with the location\\\${inlinedText}.\\\`'
                        },
                        { view: 'block', className: 'action-hint', content: 'text:"Click to display blocks"' }
                    ]
                };

                syntax: 'js',
                lineNum: => $line + $,
                source: $sourceSlice,
                marks: @.blockByOffset.({
                    offset: offset - $sourceSliceStart,
                    kind: 'dot',
                    marker: \`blocks-offset:\${offset}\`,
                    blocks,
                    content: $markerContent,
                    $tooltip
                })
            }`,
            postRender: el => el.addEventListener('click', (e) => {
                const markerEl = e.target.closest('[data-marker^="blocks-offset:"]');

                if (markerEl) {
                    blocksEl.replaceChildren();
                    el.querySelector('.selected[data-marker]')?.classList?.remove?.('selected');
                    markerEl.classList.add('selected');
                    this.render(blocksEl, {
                        view: 'code-disassemble-block-tree',
                        data: 'blockByOffset[=>offset=@.offset].blocks.disassembleBlockTree(blocks[].block.code, => block)',
                        postRender: () => blocksEl.scrollTop = 0
                    }, {
                        ...renderData,
                        offset: Number(markerEl.dataset.marker.split(':').pop())
                    }, context);
                }
            }, true)
        },
        {
            view: 'block',
            className: 'blocks-list',
            content: {
                view: 'block',
                content: 'text:"Select a location to view the related code blocks"'
            },
            postRender(el) {
                blocksEl = el;
            }
        }
    ], renderData, context);
});
