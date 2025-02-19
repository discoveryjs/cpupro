const { SubsetCallTree } = require('../prepare/computations/call-tree.js');
const { SubsetTreeTimings } = require('../prepare/computations/timings');
const { FEATURE_SOURCES } = require('../prepare/const.js');

const descendantTree = {
    view: 'block',
    content: [
        'h5:"Nested call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            context: `{ ...#, timingTree: #.consolidateCallFrames
                ? #.subsetTreeTimings
                : #.currentProfile.callFramesTreeTimingsFiltered
            }`,
            data: `
                #.timingTree
                    .select('nodes', @, not #.consolidateCallFrames)
                    .[totalTime]
                    .sort(totalTime desc, selfTime desc)
            `,
            children: `
                #.timingTree
                    .select('children', node.nodeIndex)
                    .[totalTime]
                    .sort(totalTime desc, selfTime desc, node.value.name ascN)
            `,
            item: {
                view: 'context',
                content: [
                    {
                        view: 'switch',
                        content: [
                            { when: 'node.value.id = +#.id', content: {
                                view: 'block',
                                className: 'self',
                                content: 'text:node.value.name'
                            } },
                            { content: 'auto-link:node.value' }
                        ]
                    },
                    { view: 'text', when: 'subtreeSize', data: '` (${subtreeSize}) `' },
                    {
                        view: 'block',
                        className: 'grouped',
                        data: 'grouped.size()',
                        whenData: '$ > 1',
                        content: 'text:"×" + $'
                    },
                    {
                        view: 'self-time'
                    },
                    {
                        view: 'nested-time',
                        data: 'nestedTime',
                        whenData: true
                    },
                    // { view: 'total-time', when: 'children', data: 'totalTime' },
                    {
                        view: 'context',
                        when: 'node.value.id != +#.id',
                        content: [
                            'module-badge:node.value',
                            'call-frame-loc-badge:node.value'
                        ]
                    }
                ]
            }
        }
    ]
};

const ancestorsTree = {
    view: 'block',
    content: [
        'h5:"Ancestor call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            expanded: 3,
            data: `
                #.currentProfile.callFramesTreeTimingsFiltered
                    .select('nodes', $, true)
                    .[totalTime]
                    .sort(totalTime desc)
            `,
            children: `
                node.parent ? #.currentProfile.callFramesTreeTimingsFiltered
                    .select('parent', node.nodeIndex)
                    .[totalTime]
                    .sort(totalTime desc)
            `,
            item: {
                view: 'context',
                content: [
                    {
                        view: 'switch',
                        content: [
                            { when: 'node.value.id = +#.id', content: {
                                view: 'block',
                                className: 'self',
                                content: 'text:node.value.name'
                            } },
                            { content: 'auto-link:node.value' }
                        ]
                    },
                    {
                        view: 'block',
                        className: 'grouped',
                        data: 'grouped.size()',
                        whenData: '$ > 1',
                        content: 'text:"×" + $'
                    },
                    {
                        view: 'total-time'
                    },
                    {
                        view: 'context',
                        when: 'node.value.id != +#.id',
                        content: [
                            'module-badge:node.value',
                            'call-frame-loc-badge:node.value'
                        ]
                    }
                ]
            }
        }
    ]
};

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'call-frame-kind-badge',
            // 'badge{ className: "type-badge", text: "Call frame" }',
            'badge{ className: "category-badge", text: module.category.name, href: module.category.marker().href, color: module.category.name.color() }',
            'package-badge',
            'badge{ text: module | packageRelPath or path or "module", href: module.marker().href }',
            'call-frame-loc-badge'
        ],
        content: [
            {
                view: 'hotness-icon',
                data: '#.currentProfile.codesByCallFrame[=> callFrame = @]',
                whenData: 'hotness = "hot" or hotness = "warm"',
                hotness: '=hotness',
                topTier: '=topTier'
            },
            { view: 'h1', when: 'not regexp', data: 'name' },
            {
                view: 'source',
                when: 'regexp',
                data: '{ content: regexp | size() <= 256 ?: `${$[:256]}…`, syntax: "regexp", lineNum: false }',
                className: data => data.content.length > 256 ? 'too-long' : ''
            }
        ]
    },

    {
        view: 'timeline-profiles',
        data: '#.data.profiles',
        startTime: '=.[not disabled].startTime.min()',
        endTime: '=.[not disabled].endTime.max()',
        whenData: 'size() > 1'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.currentProfile.callFramesTree }'
    },

    {
        view: 'update-on-timings-change',
        timings: '=#.currentProfile.callFramesTimingsFiltered',
        content: `page-indicator-timings:{
            full: #.currentProfile.callFramesTimings.entries[=>entry = @],
            filtered: #.currentProfile.callFramesTimingsFiltered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        when: '#.currentProfile | type = "memory" and _memoryGc and _memoryType',
        className: 'trigger-outside',
        data: '{ callFrame: @, matrix: #.currentProfile | callFramesTree.allocationsMatrix(samplesTimings, @) }',
        expanded: '=',
        header: 'text:"Allocation types"',
        content: {
            view: 'update-on-timings-change',
            timings: '=#.currentProfile.callFramesTimingsFiltered',
            content: {
                view: 'allocation-samples-matrix',
                data: `
                    $filtered: #.currentProfile | callFramesTree.allocationsMatrix(samplesTimingsFiltered, @.callFrame);

                    matrix.($type; $filtered[=>type = $type] or { $type })
                `
            }
        }
    },

    {
        view: 'expand',
        when: FEATURE_SOURCES,
        className: 'trigger-outside script-source',
        expanded: '=hasSource()',
        header: [
            'text:"Source"',
            { view: 'block', className: 'text-divider' },
            { view: 'switch', content: [
                { when: 'regexp', content: 'html:`<span style="color: #888">${regexp.size().bytes(true)}</html>`' },
                { when: 'hasSource()', content: 'html:`<span style="color: #888">${script.source.size().bytes(true)}</html>`' },
                { content: 'html:`<span style="color: #888">(unavailable)</span>`' }
            ] }
        ],
        content: 'call-frame-source'
    },

    {
        view: 'expand',
        expanded: true,
        className: 'trigger-outside',
        header: [
            'text:"Nested time distribution"',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.callFramesTimingsFiltered',
                content: 'duration:#.currentProfile.callFramesTimingsFiltered.entries[=>entry=@].nestedTime'
            }
        ],
        content: 'nested-timings-tree:{ subject: @, tree: #.currentProfile.callFramesTree, timings: #.currentProfile.callFramesTimingsFiltered }'
    },

    {
        view: 'context',
        modifiers: [
            // {
            //     view: 'checkbox',
            //     name: 'groupByRef',
            //     checked: true,
            //     content: 'text:"Group call sites"'
            // }
        ],
        content: {
            view: 'expand',
            expanded: true,
            className: 'trigger-outside',
            header: 'text:"Call trees"',
            content: {
                view: 'context',
                modifiers: [
                    {
                        view: 'checkbox',
                        name: 'consolidateCallFrames',
                        checked: true,
                        content: 'text:"Consolidate call frames"',
                        onChange() {}
                    }
                ],
                content: {
                    view: 'update-on-timings-change',
                    timings: '=#.currentProfile.callFramesTimingsFiltered',
                    debounce: 150,
                    beforeContent(data, context) {
                        if (context.consolidateCallFrames) {
                            context.subsetTreeTimings.recompute();
                        }
                    },
                    content: {
                        view: 'hstack',
                        className: 'trees',
                        content: [
                            descendantTree,
                            ancestorsTree
                        ]
                    }
                }
            }
        }
    },

    {
        view: 'flamechart-expand',
        tree: '=#.currentProfile.callFramesTree',
        subsetTimings: '=#.subsetTreeTimings'
    }
];

discovery.page.define('call-frame', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.callFrames[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No call frame with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: {
            view: 'context',
            context: (data, context) => ({
                ...context,
                subsetTreeTimings: new SubsetTreeTimings(
                    new SubsetCallTree(
                        context.currentProfile.callFramesTree,
                        data
                    ),
                    context.currentProfile.samplesTimingsFiltered
                )
            }),
            content: pageContent
        } }
    ]
});
