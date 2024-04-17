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
            view: 'flamechart',
            tree: focusTree,
            timings,
            timingsMap: focusTree.timingsMap,
            lockScrolling: true,
            postRender(el) {
                el.classList.toggle('lock-scrolling', true);
            }
        }
    }, data, context);
}, { tag: false });
