function createFlowNodeEl(node, context) {
    const el = document.createElement('span');

    el.className = 'flow-node';
    el.innerText = node.name;
    el.style.setProperty('--self-time', `${100 * node.selfTime / context.totalTime}%`);

    return el;
}

function b(el, node, context, used, up, levels, level) {
    const visitNodes = new Set();

    let containerEl = levels[level];
    if (containerEl === undefined) {
        containerEl = levels[level] = document.createElement('div');
        up ? el.prepend(containerEl) : el.append(containerEl);
        containerEl.innerText = '#' + level + ' ';
    }

    for (const child of (up ? node.parents : node.children)) {
        const rel = up ? child.from : child.to;

        if (used.has(rel)) { // TODO: fix
            // containerEl.append('[skipped ' + rel.name + ']');
            continue;
        }

        used.add(rel);
        visitNodes.add(child);

        containerEl.append(createFlowNodeEl(rel, context));
    }

    for (const node of visitNodes) {
        b(el, node, context, used, up, levels, level + 1);
    }
}

discovery.view.define('flow', function(el, config, data, context) {
    return;
    const ctx = { totalTime: context.data.totalTime };

    el.append(createFlowNodeEl(data, ctx));

    const used = new Set([data]);
    b(el, data, ctx, used, true, [], 0);

    used.clear();
    used.add(data);
    b(el, data, ctx, used, false, [], 0);
});
