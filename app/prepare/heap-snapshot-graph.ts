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
// freed with it. Nodes are numbered in a depth-first order from the root, which makes a node's dominators precede
// it, and semi-NCA takes the predecessors of every node in that order.
// PERF: The passes are bound by random access over the edges, WASM doesn't take less time. The depth-first pass
// gives every edge its target's index and counts the predecessors after a node, so predecessors take one more pass,
// in turn over nodes and edges; semi-NCA stops at the lowest semidominator a node may have, which most nodes of
// a heap reach early. Over tens of millions of nodes it takes 1.5 s rather than 2.5 s
export function computeDominatorTree(
    firstEdges: Uint32Array,
    toNodes: Uint32Array,
    edgeTypes: Uint8Array,
    weakType: number,
    selfSizes: ArrayLike<number>
) {
    const nodeCount = firstEdges.length - 1;
    const strong = { firstEdges, toNodes, edgeTypes, weakType };
    const ordered = depthFirstOrder(strong, nodeCount);
    const { vertices, reached } = ordered;
    const predecessors = orderedPredecessors(firstEdges, ordered);
    const lowest = lowestSemidominator(firstEdges, ordered);
    const orderedDominators = semiNca(ordered, predecessors, lowest);
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

// Nodes in a depth-first order of strong edges from the root, and what the pass learns of every edge: per node its
// index in the order (NO_NODE out of reach) and the number of its predecessors after it; per index its node and the
// index of its parent in the depth-first tree; per edge the index of its target, NO_NODE for a weak edge.
// PERF: The index and the count of a node are side by side, an edge reads and counts its target in one cache line
type DepthFirstOrder = {
    nodeStates: Uint32Array;  // per node: its index, then the number of its later predecessors
    vertices: Uint32Array;
    parents: Uint32Array;
    edgeTargets: Uint32Array; // per edge of a reached node
    reached: number;
};

function depthFirstOrder(strong: StrongEdges, nodeCount: number): DepthFirstOrder {
    const { firstEdges, toNodes, edgeTypes, weakType } = strong;
    const nodeStates = new Uint32Array(2 * nodeCount);
    const vertices = new Uint32Array(nodeCount);
    const parents = new Uint32Array(nodeCount);
    const edgeTargets = new Uint32Array(toNodes.length);
    const stackNodes = new Uint32Array(nodeCount);
    const stackEdges = new Uint32Array(nodeCount);
    let top = 0;
    let reached = 1;

    for (let i = 0; i < nodeCount; i++) {
        nodeStates[2 * i] = NO_NODE;
    }

    nodeStates[0] = 0;
    stackEdges[0] = firstEdges[0];

    // a node on the top of the stack takes its next edge to a node out of the order, or leaves the stack;
    // the edges it passes are to nodes in the order
    while (top >= 0) {
        const node = stackNodes[top];
        const source = nodeStates[2 * node];
        const end = firstEdges[node + 1];
        let edge = stackEdges[top];
        let target = NO_NODE;

        for (; edge < end; edge++) {
            if (edgeTypes[edge] === weakType) {
                edgeTargets[edge] = NO_NODE;
                continue;
            }

            const targetNode = toNodes[edge];
            const targetIndex = nodeStates[2 * targetNode];

            if (targetIndex === NO_NODE) {
                target = targetNode;
                break;
            }

            edgeTargets[edge] = targetIndex;

            if (source > targetIndex) {
                nodeStates[2 * targetNode + 1]++;
            }
        }

        if (target === NO_NODE) {
            top--;
            continue;
        }

        edgeTargets[edge] = reached;
        stackEdges[top] = edge + 1;
        nodeStates[2 * target] = reached;
        parents[reached] = source;
        vertices[reached] = target;
        reached++;

        top++;
        stackNodes[top] = target;
        stackEdges[top] = firstEdges[target];
    }

    return {
        nodeStates,
        vertices,
        parents,
        edgeTargets,
        reached
    };
}

// Predecessors of every index of the order: an index after it is stored, an index before it (its parent, or the
// source of a forward edge) only lowers the least earlier predecessor of the index, which semi-NCA starts with.
// The edges of reached nodes are read in turn, by nodes
function orderedPredecessors(firstEdges: Uint32Array, ordered: DepthFirstOrder) {
    const { nodeStates, parents, edgeTargets, reached } = ordered;
    const nodeCount = firstEdges.length - 1;
    const firstLater = new Uint32Array(reached + 1);
    const leastEarlier = parents.slice(0, reached);

    for (let i = 0; i < nodeCount; i++) {
        const index = nodeStates[2 * i];

        if (index !== NO_NODE) {
            firstLater[index + 1] = nodeStates[2 * i + 1];
        }
    }

    for (let i = 0; i < reached; i++) {
        firstLater[i + 1] += firstLater[i];
    }

    const nextLater = firstLater.slice(0, reached);
    const later = new Uint32Array(firstLater[reached]);

    for (let i = 0; i < nodeCount; i++) {
        const source = nodeStates[2 * i];

        if (source === NO_NODE) {
            continue;
        }

        const end = firstEdges[i + 1];

        for (let j = firstEdges[i]; j < end; j++) {
            const target = edgeTargets[j];

            if (target === NO_NODE) {
                continue;
            }

            if (source > target) {
                later[nextLater[target]++] = source;
            } else if (source < leastEarlier[target]) {
                leastEarlier[target] = source;
            }
        }
    }

    return {
        firstLater,
        later,
        leastEarlier
    };
}

// The lowest semidominator of an index after the root: a path to the index passes the root's chain of nodes with
// a single successor each, so no index before the end of the chain is a semidominator of a later one. The single
// successor of a node of the chain is the next in the order, or the order ends with the chain. A successor taken by
// several edges is one successor: taken apart, the chain would end earlier and fewer predecessors stop early
function lowestSemidominator(firstEdges: Uint32Array, ordered: DepthFirstOrder) {
    const { vertices, edgeTargets, reached } = ordered;
    let lowest = 0;

    while (lowest + 1 < reached) {
        const node = vertices[lowest];
        const end = firstEdges[node + 1];
        let successor = NO_NODE;
        let single = true;

        for (let i = firstEdges[node]; i < end; i++) {
            const target = edgeTargets[i];

            if (target === NO_NODE || target === successor) {
                continue;
            }

            if (successor !== NO_NODE) {
                single = false;
                break;
            }

            successor = target;
        }

        if (!single) {
            break;
        }

        lowest++;
    }

    return lowest;
}

// Immediate dominators of the indices of a depth-first order (semi-NCA): the semidominator of an index is the least
// index reaching it through larger indices: its least earlier predecessor, or the least semidominator on the path
// of a later predecessor to the root of the processed indices, found with path compression. The path keeps its least
// semidominator (best) rather than the index having it. The immediate dominator of an index is the nearest ancestor
// in the depth-first tree not after its semidominator
function semiNca(
    ordered: DepthFirstOrder,
    predecessors: ReturnType<typeof orderedPredecessors>,
    lowest: number
) {
    const { parents, reached } = ordered;
    const { firstLater, later, leastEarlier: semi } = predecessors;
    const best = new Uint32Array(reached);
    const ancestors = new Uint32Array(reached).fill(NO_NODE);
    const path = new Uint32Array(reached);
    const dominators = new Uint32Array(reached);

    for (let i = reached - 1; i > 0; i--) {
        const end = firstLater[i + 1];
        let semidominator = semi[i];

        // a later predecessor takes the least semidominator on its path, until none can be lower
        for (let j = firstLater[i]; j < end && semidominator > lowest; j++) {
            const predecessor = later[j];
            let length = 0;
            let ancestor = predecessor;

            while (ancestors[ancestors[ancestor]] !== NO_NODE) {
                path[length++] = ancestor;
                ancestor = ancestors[ancestor];
            }

            while (length > 0) {
                const index = path[--length];
                const parent = ancestors[index];

                if (best[parent] < best[index]) {
                    best[index] = best[parent];
                }

                ancestors[index] = ancestors[parent];
            }

            if (best[predecessor] < semidominator) {
                semidominator = best[predecessor];
            }
        }

        semi[i] = semidominator;
        best[i] = semidominator;
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
