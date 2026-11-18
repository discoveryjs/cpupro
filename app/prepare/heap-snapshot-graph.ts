// The graph of a heap snapshot over its columns: nodes are objects, edges are references of a node to another one
// in the order of their nodes. A node's edges follow the edges of the nodes before it, so the first edges of nodes
// index them; the root is the first node

export const NO_NODE = 0xFFFFFFFF;

// Per node: the index of its first edge, then the number of edges; the edges of a node end at the first edge
// of the next one
export function computeFirstEdges(edgeCounts: ArrayLike<number>, nodeCount: number) {
    const firstEdges = new Uint32Array(nodeCount + 1);

    for (let i = 0; i < nodeCount; i++) {
        firstEdges[i + 1] = firstEdges[i] + edgeCounts[i];
    }

    return firstEdges;
}

// The edges to every node, the edges to a node in the order of their owners: per node the index of its first
// retainer, then the number of retainers, and the edges of retainers
export function computeRetainers(toNodes: Uint32Array, nodeCount: number) {
    const firstRetainers = new Uint32Array(nodeCount + 1);
    const retainerEdges = new Uint32Array(toNodes.length);

    for (let i = 0; i < toNodes.length; i++) {
        firstRetainers[toNodes[i] + 1]++;
    }

    for (let i = 0; i < nodeCount; i++) {
        firstRetainers[i + 1] += firstRetainers[i];
    }

    const nextRetainers = firstRetainers.slice(0, nodeCount);

    for (let i = 0; i < toNodes.length; i++) {
        retainerEdges[nextRetainers[toNodes[i]]++] = i;
    }

    return {
        firstRetainers,
        retainerEdges
    };
}

// The node of an edge: the last node whose first edge isn't after it
export function edgeOwner(firstEdges: Uint32Array, edge: number) {
    let low = 0;
    let high = firstEdges.length - 2;

    while (low < high) {
        const middle = (low + high + 1) >> 1;

        if (firstEdges[middle] <= edge) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low;
}

// The dominator tree of the nodes reachable from the root by strong edges (all but weak ones): per node its
// immediate dominator, the node every path from the root to it passes last, NO_NODE for the root and nodes out of
// reach; and the retained size of every node, its self size and the self sizes of the nodes it dominates, the memory
// freed with it. Nodes are numbered in a depth-first order from the root, which makes a node's dominators precede it;
// the strong edges are taken as the predecessors of every node in that order, which semi-NCA reads in turn.
// PERF: The passes are bound by random access over the edges, WASM doesn't take less time
export function computeDominatorTree(
    firstEdges: Uint32Array,
    toNodes: Uint32Array,
    edgeTypes: Uint8Array,
    weakType: number,
    selfSizes: ArrayLike<number>
) {
    const nodeCount = firstEdges.length - 1;
    const strong = { firstEdges, toNodes, edgeTypes, weakType };
    const { order, vertices, parents, reached } = depthFirstOrder(strong, nodeCount);
    const { firstPredecessors, predecessors } = orderedPredecessors(strong, order, reached);
    const orderedDominators = semiNca(parents, firstPredecessors, predecessors, reached);
    const orderedRetainedSizes = new Float64Array(reached);
    const dominators = new Uint32Array(nodeCount).fill(NO_NODE);
    const retainedSizes = new Float64Array(nodeCount);

    // a node's retained size adds to its dominator's, which precedes it
    for (let i = 0; i < reached; i++) {
        orderedRetainedSizes[i] = selfSizes[vertices[i]];
    }

    for (let i = reached - 1; i > 0; i--) {
        orderedRetainedSizes[orderedDominators[i]] += orderedRetainedSizes[i];
    }

    // nodes out of reach retain their own memory only
    for (let i = 0; i < nodeCount; i++) {
        retainedSizes[i] = selfSizes[i];
    }

    for (let i = 0; i < reached; i++) {
        const node = vertices[i];

        retainedSizes[node] = orderedRetainedSizes[i];

        if (i > 0) {
            dominators[node] = vertices[orderedDominators[i]];
        }
    }

    return {
        dominators,
        retainedSizes
    };
}

// The number of strong edges on a shortest path from the root to every node, NO_NODE out of reach
export function computeDistances(
    firstEdges: Uint32Array,
    toNodes: Uint32Array,
    edgeTypes: Uint8Array,
    weakType: number
) {
    const nodeCount = firstEdges.length - 1;
    const distances = new Uint32Array(nodeCount).fill(NO_NODE);
    const queue = new Uint32Array(nodeCount);
    let head = 0;
    let tail = 0;

    distances[0] = 0;
    queue[tail++] = 0;

    while (head < tail) {
        const node = queue[head++];
        const distance = distances[node] + 1;
        const end = firstEdges[node + 1];

        for (let i = firstEdges[node]; i < end; i++) {
            const target = toNodes[i];

            if (edgeTypes[i] !== weakType && distances[target] === NO_NODE) {
                distances[target] = distance;
                queue[tail++] = target;
            }
        }
    }

    return distances;
}

type StrongEdges = {
    firstEdges: Uint32Array;
    toNodes: Uint32Array;
    edgeTypes: Uint8Array;
    weakType: number;
};

// Nodes in a depth-first order of strong edges from the root: per node its index in the order, NO_NODE out of reach;
// per index its node and the index of its parent in the depth-first tree
function depthFirstOrder(strong: StrongEdges, nodeCount: number) {
    const { firstEdges, toNodes, edgeTypes, weakType } = strong;
    const order = new Uint32Array(nodeCount).fill(NO_NODE);
    const vertices = new Uint32Array(nodeCount);
    const parents = new Uint32Array(nodeCount);
    const stackNodes = new Uint32Array(nodeCount);
    const stackEdges = new Uint32Array(nodeCount);
    let top = 0;
    let reached = 1;

    order[0] = 0;
    stackEdges[0] = firstEdges[0];

    // a node on the top of the stack takes its next edge to a node out of the order, or leaves the stack
    while (top >= 0) {
        const node = stackNodes[top];
        const end = firstEdges[node + 1];
        let edge = stackEdges[top];

        let target = NO_NODE;

        for (; edge < end; edge++) {
            if (edgeTypes[edge] !== weakType && order[toNodes[edge]] === NO_NODE) {
                target = toNodes[edge];
                break;
            }
        }

        if (target === NO_NODE) {
            top--;
            continue;
        }

        stackEdges[top] = edge + 1;
        order[target] = reached;
        parents[reached] = order[node];
        vertices[reached] = target;
        reached++;

        top++;
        stackNodes[top] = target;
        stackEdges[top] = firstEdges[target];
    }

    return {
        order,
        vertices,
        parents,
        reached
    };
}

// The strong edges between reached nodes as predecessors of every index of the order: per index its first
// predecessor, then the number of predecessors, and the indices of predecessors
function orderedPredecessors(strong: StrongEdges, order: Uint32Array, reached: number) {
    const { firstEdges, toNodes, edgeTypes, weakType } = strong;
    const nodeCount = order.length;
    const firstPredecessors = new Uint32Array(reached + 1);
    let count = 0;

    for (let i = 0; i < nodeCount; i++) {
        if (order[i] === NO_NODE) {
            continue;
        }

        const end = firstEdges[i + 1];

        for (let j = firstEdges[i]; j < end; j++) {
            const target = order[toNodes[j]];

            if (edgeTypes[j] !== weakType && target !== NO_NODE) {
                firstPredecessors[target + 1]++;
                count++;
            }
        }
    }

    for (let i = 0; i < reached; i++) {
        firstPredecessors[i + 1] += firstPredecessors[i];
    }

    const nextPredecessors = firstPredecessors.slice(0, reached);
    const predecessors = new Uint32Array(count);

    for (let i = 0; i < nodeCount; i++) {
        const source = order[i];

        if (source === NO_NODE) {
            continue;
        }

        const end = firstEdges[i + 1];

        for (let j = firstEdges[i]; j < end; j++) {
            const target = order[toNodes[j]];

            if (edgeTypes[j] !== weakType && target !== NO_NODE) {
                predecessors[nextPredecessors[target]++] = source;
            }
        }
    }

    return {
        firstPredecessors,
        predecessors
    };
}

// Immediate dominators of the indices of a depth-first order (semi-NCA): the semidominator of an index is the least
// index reaching it through larger indices, found over its predecessors with path compression of the processed
// indices; its immediate dominator is the nearest ancestor in the depth-first tree not after its semidominator
function semiNca(parents: Uint32Array, firstPredecessors: Uint32Array, predecessors: Uint32Array, reached: number) {
    const semi = new Uint32Array(reached);
    const labels = new Uint32Array(reached);
    const ancestors = new Uint32Array(reached).fill(NO_NODE);
    const path = new Uint32Array(reached);
    const dominators = new Uint32Array(reached);

    for (let i = 0; i < reached; i++) {
        semi[i] = i;
        labels[i] = i;
    }

    for (let i = reached - 1; i > 0; i--) {
        const end = firstPredecessors[i + 1];
        let semidominator = semi[i];

        for (let j = firstPredecessors[i]; j < end; j++) {
            const predecessor = predecessors[j];
            let label = predecessor;

            // a processed predecessor takes the least semidominator on its path of processed ancestors
            if (ancestors[predecessor] !== NO_NODE) {
                let length = 0;
                let ancestor = predecessor;

                while (ancestors[ancestors[ancestor]] !== NO_NODE) {
                    path[length++] = ancestor;
                    ancestor = ancestors[ancestor];
                }

                while (length > 0) {
                    const index = path[--length];
                    const parent = ancestors[index];

                    if (semi[labels[parent]] < semi[labels[index]]) {
                        labels[index] = labels[parent];
                    }

                    ancestors[index] = ancestors[parent];
                }

                label = labels[predecessor];
            }

            if (semi[label] < semidominator) {
                semidominator = semi[label];
            }
        }

        semi[i] = semidominator;
        ancestors[i] = parents[i];
    }

    for (let i = 1; i < reached; i++) {
        let dominator = parents[i];

        while (dominator > semi[i]) {
            dominator = dominators[dominator];
        }

        dominators[i] = dominator;
    }

    return dominators;
}
