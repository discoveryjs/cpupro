const { SubsetCallTree, AncestorSubsetCallTree } = require('../prepare/computations/call-tree.js');
const { SubsetTreeMetrics, AncestorSubsetTreeMetrics } = require('../prepare/computations/metrics.js');
const { sessionExpandState, primaryLineSwitcher } = require('./common.js');
const { resolveScopeProfileLine } = require('../jora/profile.js');

const descendantTree = {
    view: 'block',
    content: [
        'h5:"Nested call sites"',
        {
            view: 'tree',
            className: 'call-tree',
            context: `{ ...#, consolidatedValueTree: #.consolidateCallFrames
                ? #.subsetTreeValues
                : scopeLine().tree.callFrames.filtered
            }`,
            data: `
                #.consolidatedValueTree
                    .select('nodes', @, not #.consolidateCallFrames)
                    .[totalValue]
                    .sort(totalValue desc, selfValue desc)
            `,
            children: `
                #.consolidatedValueTree
                    .select('children', node.nodeIndex)
                    .[totalValue]
                    .sort(totalValue desc, selfValue desc, node.value.name ascN)
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
                            { content: [
                                'call-frame-kind-badge:node.value',
                                'auto-link:node.value'
                            ] }
                        ]
                    },
                    // { view: 'text', when: 'node.subtreeSize', data: '` (${node.subtreeSize}) `' },
                    // {
                    //     view: 'block',
                    //     className: 'grouped',
                    //     data: 'grouped.size()',
                    //     whenData: '$ > 1',
                    //     content: 'text:"×" + $'
                    // },
                    {
                        view: 'self-value'
                    },
                    {
                        view: 'nested-value',
                        data: 'nestedValue',
                        whenData: true
                    },
                    // { view: 'total-time', when: 'children', data: 'totalValue' },
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
            context: `{
                $secondaryLine: secondaryLine(#.primaryLineType = "timeline" ? "memline" : "timeline");

                ...#,
                ancestorTree: #.consolidateCallFrames
                    ? #.ancestorSubsetTreeValues
                    : scopeLine().tree.callFrames.filtered,
                $secondaryLine,
                secondaryTree: #.consolidateCallFrames
                    ? #.secondaryAncestorSubsetTreeValues
                    : $secondaryLine.tree.callFrames.filtered
            }`,
            data: `
                #.ancestorTree
                    .select('nodes', @)
                    .[totalValue]
                    .sort(totalValue desc)
            `,
            children: `
                #.ancestorTree
                    .select(#.consolidateCallFrames ? 'children' : 'parent', node.nodeIndex)
                    .[totalValue]
                    .sort(totalValue desc, selfValue desc, node.value.name ascN)
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
                            { content: [
                                'call-frame-kind-badge:node.value',
                                'auto-link:node.value'
                            ] }
                        ]
                    },
                    // { view: 'text', when: '#.consolidateCallFrames and node.subtreeSize', data: '` (${node.subtreeSize}) `' },
                    // {
                    //     view: 'block',
                    //     className: 'grouped',
                    //     data: 'grouped.size()',
                    //     whenData: '$ > 1',
                    //     content: 'text:"×" + $'
                    // },
                    {
                        view: 'total-value'
                    },
                    {
                        view: 'total-value',
                        when: '#.secondaryTree',
                        data: '#.secondaryTree.getMetrics(node.nodeIndex)',
                        line: '=#.secondaryLine'
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
            'call-frame-loc-badge',
            primaryLineSwitcher
        ],
        content: [
            {
                view: 'code-hotness-icon',
                data: 'scopeProfile().codesByCallFrame[=> callFrame = @]',
                whenData: 'hotness in ["hot", "warm"]',
                tier: '=topTier'
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
        data: '#.profiles',
        startTime: '=.[not disabled].primaryLine().axisStart.min()',
        endTime: '=.[not disabled].primaryLine().axisEnd.max()',
        whenData: 'size() > 1'
    },

    {
        view: 'subject-with-nested-timeline',
        data: '{ subject: @, tree: #.scopeProfile.callFramesTree }'
    },

    {
        view: 'update-on-line-metrics-changes',
        metrics: '=scopeLine().dict.callFrames.filtered',
        content: `page-indicator-metrics:{
            full: scopeLine().dict.callFrames.all.entries[=>entry = @],
            filtered: scopeLine().dict.callFrames.filtered.entries[=>entry = @]
        }`
    },

    {
        view: 'expand',
        when: 'primaryLine().type = "timeline"',
        className: 'trigger-outside call-frame-codes',
        data: 'scopeProfile().codesByCallFrame[=> callFrame = @].codes',
        ...sessionExpandState('callframe-codes', true, '$'),
        header: [
            'text:"Codes"',
            { view: 'block', className: 'text-divider' },
            { view: 'switch', content: [
                { when: 'size()', content: 'text:size()' },
                { content: 'html:`<span style="color: #888">(unavailable)</span>`' }
            ] }
        ],
        content: {
            view: 'call-frame-codes-table',
            limit: { start: 5, tolerance: 3, base: false }
        }
    },

    {
        view: 'expand',
        when: '#.scopeProfile | memline | valueLifespans and valueTypes',
        className: 'trigger-outside',
        data: '{ callFrame: @, matrix: #.scopeProfile.memline | tree.callFrames.all.tree.allocationsMatrix(samplesMetrics, @) }',
        ...sessionExpandState('callframe-allocations-matrix', true, '$'),
        header: 'text:"Allocation types"',
        content: {
            view: 'update-on-line-metrics-changes',
            metrics: '=#.scopeProfile.memline.dict.callFrames.filtered',
            content: {
                view: 'allocation-samples-matrix',
                data: `
                    $filtered: #.scopeProfile.memline | tree.callFrames.all.tree.allocationsMatrix(samplesMetricsFiltered, @.callFrame);

                    matrix.($type; $filtered[=>type = $type] or { $type })
                `
            }
        }
    },

    {
        view: 'expand',
        className: 'trigger-outside script-source',
        context: '{ ...#, currentCallFrame: $ }',
        expanded: '=#.currentCallFrame.hasSource() and "getSessionSetting".callAction("cpupro-call-frame-source", true)',
        onToggle: '=#.currentCallFrame.hasSource() ?=> "setSessionSetting".callAction("cpupro-call-frame-source", $)',
        header: [
            'text:"Source"',
            { view: 'block', className: 'text-divider' },
            { view: 'switch', content: [
                { when: 'regexp', content: 'text-with-unit{ value: regexp.size() | bytes(), unit: true }' },
                { when: 'hasSource()', content: 'text-with-unit{ value: end - start | bytes(), unit: true }' },
                { content: 'html:`<span style="color: #888">(unavailable)</span>`' }
            ] }
        ],
        content: 'call-frame-source'
    },

    {
        view: 'expand',
        ...sessionExpandState('callframe-nested-time-distribution', true),
        className: 'trigger-outside',
        header: [
            'text:`${"nestedValue".metricName()} distribution`',
            { view: 'block', className: 'text-divider' },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().dict.callFrames.filtered',
                content: 'metric:scopeLine().dict.callFrames.filtered.entries[=>entry=@].nestedValue'
            }
        ],
        content: `nested-timings-tree:scopeLine() | {
            subject: @,
            tree: profile.callFramesTree,
            metrics: dict.callFrames.filtered
        }`
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
            ...sessionExpandState('callframe-call-trees', true),
            className: 'trigger-outside',
            header: 'text:"Call trees"',
            content: {
                view: 'context',
                modifiers: [
                    {
                        view: 'checkbox',
                        name: 'consolidateCallFrames',
                        checked: true,
                        content: 'text:"Consolidate call frames"'
                    }
                ],
                content: {
                    view: 'update-on-line-metrics-changes',
                    metrics: '=scopeLine().dict.callFrames.filtered',
                    debounce: 150,
                    beforeContent(data, context) {
                        if (context.consolidateCallFrames) {
                            context.subsetTreeValues.recompute();
                            context.ancestorSubsetTreeValues.recompute();
                            context.secondaryAncestorSubsetTreeValues?.recompute();
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
        ...sessionExpandState('callframe-flame-graphs', true),
        tree: '=#.scopeProfile.callFramesTree',
        subsetTreeValues: '=#.subsetTreeValues'
    }
];

discovery.page.define('call-frame', {
    view: 'switch',
    context: '{ ...#, scopeProfile: #.primaryProfile, scopeLine: #.scopeProfile.primaryLine() }',
    data: '#.scopeProfile.callFrames[=>id = +#.id]',
    content: [
        { when: 'no $', content: {
            view: 'alert-warning',
            content: 'md:"No call frame with id \\"{{#.id}}\\" is found\\n\\n[Back to index page](#)"'
        } },
        { content: {
            view: 'context',
            context: (data, context) => {
                const scopeLine = resolveScopeProfileLine(null, context);
                const scopeProfile = scopeLine.profile;

                const callFramesTree = scopeProfile.callFramesTree;
                const samplesMetrics = scopeLine.samplesMetricsFiltered;
                const originalTreeMetrics = scopeLine.tree.callFrames.filtered;
                const secondaryLine = scopeProfile.lines.find(
                    line => line.type !== context.primaryLineType
                ) ?? null;
                const ancestorTree = new AncestorSubsetCallTree(callFramesTree, data);

                return {
                    ...context,
                    subsetTreeValues: new SubsetTreeMetrics(
                        new SubsetCallTree(callFramesTree, data),
                        samplesMetrics
                    ),
                    ancestorSubsetTreeValues: new AncestorSubsetTreeMetrics(
                        ancestorTree,
                        originalTreeMetrics
                    ),
                    secondaryAncestorSubsetTreeValues: secondaryLine
                        ? new AncestorSubsetTreeMetrics(
                            ancestorTree,
                            secondaryLine.tree.callFrames.filtered
                        )
                        : null
                };
            },
            content: pageContent
        } }
    ]
});
