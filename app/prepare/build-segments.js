function openSegments(from, to, totalTime, map, rootNode) {
    let fromNode = null;

    while (from !== null && from !== to) {
        const segment = [totalTime, 0];

        map[from.id] = fromNode = {
            host: from.function,
            children: fromNode ? [fromNode] : [],
            segment
        };

        from.segments.push(segment);
        from = from.parent;
    }

    if (fromNode) {
        (from ? map[from.id] : rootNode).children.push(fromNode);
    }
}

function closeSegments(from, to, totalTime, map) {
    while (from !== null && from !== to) {
        map[from.id] = null;
        from.segments[from.segments.length - 1][1] = totalTime;
        from = from.parent;
    }
}

function bubbleDepth(from, depth) {
    while (from !== null && from.depth !== depth) {
        from = from.parent;
    }

    return from;
}

function findCommonAncestor(a, b) {
    if (a.depth !== b.depth) {
        if (a.depth > b.depth) {
            a = bubbleDepth(a, b.depth);
        } else {
            b = bubbleDepth(b, a.depth);
        }
    }

    while (a !== b && a !== null && b !== null) {
        a = a.parent;
        b = b.parent;
    }

    return a === null || b === null ? null : a;
}

export function buildSegments(data, nodeById, gcNode) {
    let lastNode = nodeById[data.samples[0]];
    let totalTime = 0;
    const treeNodes = Array.from(nodeById, () => null);
    const gcParentNode = gcNode ? gcNode.parent : null;
    const root = {
        host: null,
        children: []
    };

    openSegments(lastNode, null, totalTime, treeNodes, root);

    for (let i = 1; i < data.timeDeltas.length; i++) {
        const delta = data.timeDeltas[i];

        // a delta might be negative sometimes, just ignore such samples
        if (delta > 0) {
            const node = nodeById[data.samples[i - 1]];

            if (node !== lastNode) {
                if (node === gcNode) {
                    node.parent = lastNode;
                    node.depth = lastNode.depth + 1;
                    openSegments(node, lastNode, totalTime, treeNodes, root);
                } else {
                    const commonAncestor = findCommonAncestor(lastNode, node);

                    closeSegments(lastNode, commonAncestor, totalTime, treeNodes);
                    openSegments(node, commonAncestor, totalTime, treeNodes, root);
                }
            }

            lastNode = node;
            totalTime += delta;
        }
    }

    closeSegments(lastNode, null, totalTime, treeNodes);

    if (gcNode) {
        gcNode.parent = gcParentNode;
    }

    return root.children[0];
}
