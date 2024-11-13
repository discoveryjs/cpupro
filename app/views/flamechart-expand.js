const { FocusCallTree } = require('../prepare/computations/call-tree.js');

discovery.view.define('flamechart-expand', function(el, config, data, context) {
    const {
        header,
        tree,
        profile = context.data.currentProfile,
        timings,
        value
    } = config;
    const focusTree = new FocusCallTree(tree, value);

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
                tree: focusTree,
                timings,
                timingsMap: focusTree.timingsMap,
                lockScrolling: true,
                postRender(el) {
                    el.classList.toggle('lock-scrolling', true);
                }
            }
        }
    }, data, context);
}, { tag: false });
