const { resolveScopeProfileLine } = require('../jora/profile.js');
const { SubsetCallTree } = require('../prepare/computations/call-tree.js');
const { SubsetTreeMetrics } = require('../prepare/computations/metrics.js');

function getTreeMetrics(line, tree) {
    for (const dimentionTrees of line.trees) {
        for (const dimensionName of ['locations', 'callFrames', 'modules', 'packages', 'categories']) {
            const dimension = dimentionTrees[dimensionName];

            if (dimension?.filtered.nodes.tree === tree) {
                return dimension.filtered.nodes;
            }
        }
    }

    return null;
}

discovery.view.define('flamechart-expand', function(el, config, data, context) {
    const {
        header,
        expanded = true,
        onToggle,
        tree,
        subsetTreeValues: computedValues,
        value
    } = config;
    const line = resolveScopeProfileLine(config.line, context);
    const samplesMetrics = line.samplesMetricsFiltered;
    const sourceTreeMetrics = getTreeMetrics(line, tree);
    if (!computedValues && sourceTreeMetrics === null) {
        throw new Error('Unable to resolve source tree metrics for flamechart expansion');
    }

    const subsetTreeValues = computedValues || new SubsetTreeMetrics(
        value ? new SubsetCallTree(tree, value) : tree,
        samplesMetrics,
        sourceTreeMetrics
    );

    return this.render(el, {
        view: 'expand',
        expanded,
        onToggle,
        className: 'flamechart-expand trigger-outside',
        header: header || 'text:"Subtree flame graphs"',
        content: {
            view: 'context',
            modifiers: {
                view: 'block',
                className: 'toolbar',
                content: [
                    {
                        view: 'toggle-group',
                        name: 'dataset',
                        data: [
                            { text: 'Categories', value: 'categoriesTree', active: tree === line.profile.categoriesTree },
                            { text: 'Packages', value: 'packagesTree', active: tree === line.profile.packagesTree },
                            { text: 'Modules', value: 'modulesTree', active: tree === line.profile.modulesTree },
                            { text: 'Call frames', value: 'callFramesTree', active: tree === line.profile.callFramesTree }
                        ]
                    }
                ]
            },
            content: {
                view: 'flamechart',
                tree: subsetTreeValues.tree,
                timings: subsetTreeValues,
                // timingsMap: focusTree.timingsMap,
                lockScrolling: true,
                postRender(el) {
                    el.classList.toggle('lock-scrolling', true);
                }
            }
        }
    }, data, context);
}, { tag: false });
