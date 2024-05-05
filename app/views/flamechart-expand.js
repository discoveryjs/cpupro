const { FocusCallTree } = require('../prepare/call-tree.js');

discovery.view.define('flamechart-expand', function(el, config, data, context) {
    const { header, tree, timings, value } = config;
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
                            { text: 'Categories', value: 'categoriesTree', active: tree === context.data.categoriesTree },
                            { text: 'Packages', value: 'packagesTree', active: tree === context.data.packagesTree },
                            { text: 'Modules', value: 'modulesTree', active: tree === context.data.modulesTree },
                            { text: 'Functions', value: 'functionsTree', active: tree === context.data.functionsTree }
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
