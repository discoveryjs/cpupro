const { resolveScopeProfileLine } = require('../jora/profile.js');
const { SubsetCallTree } = require('../prepare/computations/call-tree.js');
const { SubsetTreeMetrics } = require('../prepare/computations/metrics.js');

function getTreeDimension(line, tree) {
    for (const dimensionTrees of line.trees) {
        for (const dimensionName of ['locations', 'callFrames', 'modules', 'packages', 'categories']) {
            const dimension = dimensionTrees[dimensionName];

            if (dimension?.filtered.nodes.tree === tree) {
                return {
                    dimensions: dimensionTrees,
                    dimensionName,
                    dimension
                };
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
    const {
        dimensions,
        dimension
    } = getTreeDimension(line, tree);
    const sourceTreeMetrics = dimension.filtered.nodes;

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
                            { text: 'Categories', value: 'categories', active: dimension === dimensions.categories },
                            { text: 'Packages', value: 'packages', active: dimension === dimensions.packages },
                            { text: 'Modules', value: 'modules', active: dimension === dimensions.modules },
                            { text: 'Call frames', value: 'callFrames', active: dimension === dimensions.callFrames }
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
