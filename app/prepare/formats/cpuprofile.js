function isObject(value) {
    return typeof value === 'object' && value !== null;
}

function isNode(value) {
    if (!isObject(value)) {
        return false;
    }

    if (typeof value.id !== 'number') {
        return false;
    }

    if (!isObject(value.callFrame) || Number.isInteger(value.callFrame.id)) {
        return false;
    }

    return true;
}

function isArrayLike(value, check) {
    if (!Array.isArray(value)) {
        return false;
    }

    return value.length > 0
        ? check(value[0]) && (value.length === 1 || check(value[1]))
        : true;
}

export function isCPUProfile(data) {
    if (!isObject(data)) {
        return false;
    }

    if (!isArrayLike(data.nodes, isNode)) {
        return false;
    }

    if (!isArrayLike(data.samples, Number.isInteger)) {
        return false;
    }

    if (!isArrayLike(data.timeDeltas, Number.isInteger)) {
        return false;
    }

    return true;
}

// nodes may missing children field but have parent field, rebuild children arrays then;
// avoid updating children when nodes have parent and children fields
export function convertParentIntoChildrenIfNeeded(data) {
    const nodes = data.nodes;

    // no action when just one node or both first nodes has no parent (since only root node can has no parent)
    if (nodes.length < 2 || (typeof nodes[0].parent !== 'number' && typeof nodes[1].parent !== 'number')) {
        return;
    }

    // build map for nodes with no children only
    const nodeWithNoChildrenById = new Map();

    for (const node of data.nodes) {
        if (!Array.isArray(node.children) || node.children.length === 0) {
            nodeWithNoChildrenById.set(node.id, node);
        }
    }

    // rebuild children for nodes which missed it
    if (nodeWithNoChildrenById.size > 0) {
        for (const node of data.nodes) {
            if (typeof node.parent === 'number') {
                const parent = nodeWithNoChildrenById.get(node.parent);

                if (parent !== undefined) {
                    if (Array.isArray(parent.children)) {
                        parent.children.push(node.id);
                    } else {
                        parent.children = [node.id];
                    }
                }
            }
        }
    }
}
