const { SubsetCallTree } = require('../prepare/computations/call-tree.js');
const { SubsetTreeTimings } = require('../prepare/computations/timings.js');

discovery.view.define('flamechart-expand', function(el, config, data, context) {
    const {
        header,
        tree,
        subsetTimings: rawTimings,
        profile = context.data.currentProfile,
        samplesTimings = profile.samplesTimingsFiltered,
        value
    } = config;
    const subsetTimings = rawTimings || new SubsetTreeTimings(
        value ? new SubsetCallTree(tree, value) : tree,
        samplesTimings
    );

    return this.render(el, {
        view: 'expand',
        expanded: true,
        className: 'flamechart-expand trigger-outside',
        header: header || 'text:"Subtrees flame chart"',
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
                            { text: 'Categories', value: 'categoriesTree', active: tree === profile.categoriesTree },
                            { text: 'Packages', value: 'packagesTree', active: tree === profile.packagesTree },
                            { text: 'Modules', value: 'modulesTree', active: tree === profile.modulesTree },
                            { text: 'Call frames', value: 'callFramesTree', active: tree === profile.callFramesTree }
                        ]
                    }
                ]
            },
            content: {
                view: 'flamechart',
                tree: subsetTimings.tree,
                timings: subsetTimings,
                // timingsMap: focusTree.timingsMap,
                lockScrolling: true,
                postRender(el) {
                    el.classList.toggle('lock-scrolling', true);
                }
            }
        }
    }, data, context);
}, { tag: false });
