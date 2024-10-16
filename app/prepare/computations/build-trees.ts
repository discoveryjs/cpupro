import { TIMINGS } from '../const';
import { CallTree } from './call-tree.js';
import { CpuProCallFrame, CpuProNode } from '../types.js';
import { Dictionary } from '../dictionary';

interface TreeSource<S> {
    dictionary: S[];
    parent: Uint32Array;
    nodes: Uint32Array;
    sourceIdToNode: Int32Array;
}

export function createTreeSourceFromParent<S>(
    parent: Uint32Array,
    sourceIdToNode: Int32Array,
    nodes: Uint32Array,
    dictionary: S[]
): TreeSource<S> {
    const nodeToSourceId = new Uint32Array(parent.length);
    const { firstChild, nextSibling } = firstNextFromParent(parent);
    const { nodes: computedNodes, parent: computedParent } = nodesParentFromFirstNext(firstChild, nextSibling);

    for (let id = 0; id < sourceIdToNode.length; id++) {
        const index = sourceIdToNode[id];

        if (index !== -1) {
            nodeToSourceId[index] = id;
        }
    }

    for (let i = 0; i < parent.length; i++) {
        sourceIdToNode[nodeToSourceId[computedNodes[i]]] = i;
        computedNodes[i] = nodes[computedNodes[i]];
    }

    return {
        dictionary,
        sourceIdToNode,
        parent: computedParent,
        nodes: computedNodes
    };
}

export function firstNextFromParent(
    parent: Uint32Array,
    firstChild = new Uint32Array(parent.length),
    nextSibling = new Uint32Array(parent.length)
) {
    for (let i = parent.length - 1; i > 0; i--) {
        const pi = parent[i];

        nextSibling[i] = firstChild[pi];
        firstChild[pi] = i;
    }

    return {
        firstChild,
        nextSibling
    };
}

export function nestedFromNodesSubtree(
    nodes: Uint32Array,
    subtreeSize: Uint32Array,
    dictionarySize: number,
    nested = new Uint32Array(nodes.length)
) {
    const nestedMask = new Uint32Array(dictionarySize);

    nestedMask[nodes[0]] = nodes.length + 1;

    for (let i = 1; i < nodes.length; i++) {
        if (nestedMask[nodes[i]] >= i) {
            nested[i] = 1;
        } else {
            nestedMask[nodes[i]] = i + subtreeSize[i];
        }
    }

    return nested;
}

export function subtreeFromParent(
    parent: Uint32Array,
    subtreeSize = new Uint32Array(parent.length)
) {
    for (let i = parent.length - 1; i > 0; i--) {
        subtreeSize[parent[i]] += subtreeSize[i] + 1;
    }

    return subtreeSize;
}

// costruct a new nodes order by firstChild and nextSibling arrays
// nodes[i] -> index in a source array
export function nodesParentFromFirstNext(
    firstChild: Uint32Array,
    nextSibling: Uint32Array,
    nodes = new Uint32Array(firstChild.length),
    parent = new Uint32Array(firstChild.length)
) {
    let cursor = 0;
    let index = 0;

    do {
        const first = firstChild[cursor];
        let next = nextSibling[cursor];
        let nodeIndex = index++;

        nodes[nodeIndex] = cursor;

        if (first !== 0) {
            cursor = first;
            parent[index] = nodeIndex;
        } else if (next !== 0) {
            cursor = next;
            parent[index] = parent[nodeIndex];
        } else {
            cursor = 0;
            while (nodeIndex = parent[nodeIndex]) {
                if (next = nextSibling[nodes[nodeIndex]]) {
                    parent[index] = parent[nodeIndex];
                    cursor = next;
                    break;
                }
            }
        }
    } while (cursor !== 0);

    return { nodes, parent };
}

function remapNodes(
    nodes: Uint32Array,
    sourceNodes: Uint32Array,
    sourceToNode: Int32Array,
    sourceToDictionary: Uint32Array
) {
    const remap = new Uint32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        remap[sourceToNode[nodes[i]]] = i;
        nodes[i] = sourceToDictionary[sourceNodes[nodes[i]]];
    }

    for (let i = 0; i < sourceToNode.length; i++) {
        sourceToNode[i] = remap[sourceToNode[i]];
    }
}

function finalizeArrays(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceToNode: Int32Array,
    sourceToDictionary: Uint32Array,
    nodesSize: number,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    const nodes = new Uint32Array(nodesSize);
    const parent = new Uint32Array(nodesSize);
    const subtreeSize = new Uint32Array(nodesSize);
    const nested = new Uint32Array(nodesSize);

    nodesParentFromFirstNext(firstChild, nextSibling, nodes, parent);
    remapNodes(nodes, sourceNodes, sourceToNode, sourceToDictionary);
    subtreeFromParent(parent, subtreeSize);
    nestedFromNodesSubtree(nodes, subtreeSize, dictionarySize, nested);

    return { nodes, parent, subtreeSize, nested };
}

function rollupTreeByCommonValues(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceIdToNode: Int32Array,
    sourceToDictionary: Uint32Array,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    const valueToNodeEpoch = new Uint32Array(dictionarySize);
    const valueToNode = new Uint32Array(dictionarySize);
    const valueToNodeTail = new Uint32Array(dictionarySize);
    let nodesCount = 1;

    for (let i = 0; i < firstChild.length; i++) {
        const nodeIndex = i;
        const nodeValue = sourceToDictionary[sourceNodes[nodeIndex]];
        let prevCursor = nodeIndex;

        for (let cursor = firstChild[i]; cursor !== 0;) {
            const childValue = sourceToDictionary[sourceNodes[cursor]];

            if (childValue === nodeValue) {
                const cursorFirstChild = firstChild[cursor];
                const cursorNextSibling = nextSibling[cursor];

                sourceIdToNode[cursor] = sourceIdToNode[nodeIndex];

                if (prevCursor === nodeIndex) {
                    firstChild[prevCursor] = cursorFirstChild || cursorNextSibling;
                } else {
                    nextSibling[prevCursor] = cursorFirstChild || cursorNextSibling;
                }

                // replace cursor's node with its children
                if (cursorFirstChild) {
                    if (cursorNextSibling) {
                        let lastChild = cursorFirstChild;

                        while (nextSibling[lastChild] !== 0) {
                            lastChild = nextSibling[lastChild];
                        }

                        nextSibling[lastChild] = cursorNextSibling;
                    }

                    firstChild[cursor] = 0;
                    cursor = cursorFirstChild;
                    continue;
                }
                // when no children just ignore
            } else {
                if (valueToNodeEpoch[childValue] === nodeIndex + 1) {
                    // node already created, move children to existing node if any
                    const cursorFirstChild = firstChild[cursor];
                    const existedNode = valueToNode[childValue];

                    sourceIdToNode[cursor] = sourceIdToNode[existedNode];
                    nextSibling[prevCursor] = nextSibling[cursor];

                    if (cursorFirstChild) {
                        const existedFirstChild = firstChild[existedNode];

                        // if existed node has children, append cursor's children to then
                        //
                        // before:
                        //
                        //    [existed node]     [cursor node]
                        //     ↓                  ↓
                        //     A → … → B → 0      C → … → D → 0
                        //
                        // after:
                        //
                        //    [existed node]                [cursor node]
                        //     ↓                             ↓
                        //     A → … → B → C → … → D → 0     0
                        //
                        if (existedFirstChild !== 0) {
                            let lastChild = valueToNodeTail[childValue];

                            // search for last child
                            while (nextSibling[lastChild] !== 0) {
                                lastChild = nextSibling[lastChild];
                            }

                            nextSibling[lastChild] = cursorFirstChild;
                            valueToNodeTail[childValue] = lastChild;
                        } else {
                            firstChild[existedNode] = cursorFirstChild;
                            valueToNodeTail[childValue] = cursorFirstChild;
                        }

                        // prevent further visiting cursor node, because its children moved
                        firstChild[cursor] = 0;
                    }
                } else {
                    // create new node
                    valueToNodeEpoch[childValue] = nodeIndex + 1;
                    valueToNode[childValue] = cursor;
                    valueToNodeTail[childValue] = firstChild[cursor];

                    sourceIdToNode[cursor] = nodesCount++;
                    prevCursor = cursor;
                }
            }

            cursor = nextSibling[cursor];
        }
    }

    return nodesCount;
}

export function buildCallTree<S extends CpuProNode, D extends CpuProNode>(
    source: TreeSource<S>,
    dictionary: D[],
    sourceNodeToDictionaryFn: (node: S) => number
) {
    const initTimeStart = Date.now();
    const sourceNodes = source.nodes;
    const sourceDictionary = source.dictionary;
    const sourceIdToNode = new Int32Array(sourceNodes.length);
    const sourceToDictionary = new Uint32Array(sourceDictionary.length);
    const { firstChild, nextSibling } = firstNextFromParent(source.parent);

    const sourceToDictStart = Date.now();
    for (let i = 0; i < sourceDictionary.length; i++) {
        sourceToDictionary[i] = sourceNodeToDictionaryFn(sourceDictionary[i]);
    }

    const rollupTreeStart = Date.now();
    const nodesCount = rollupTreeByCommonValues(
        dictionary.length,
        sourceNodes,
        sourceIdToNode,
        sourceToDictionary,
        firstChild,
        nextSibling
    );

    const finalizeStart = Date.now();
    const { nodes, parent, subtreeSize, nested } = finalizeArrays(
        dictionary.length,
        sourceNodes,
        sourceIdToNode,
        sourceToDictionary,
        nodesCount,
        firstChild,
        nextSibling
    );

    const createTreeStart = Date.now();
    const tree = new CallTree(dictionary, sourceIdToNode, nodes, parent, subtreeSize, nested)
        .computeEntryNodes();

    if (TIMINGS) {
        console.info(
            '---> buildTree()',
            sourceToDictStart - initTimeStart, '(fc/ns) +',
            rollupTreeStart - sourceToDictStart, '(dict) +',
            finalizeStart - rollupTreeStart, '(rollup) +',
            createTreeStart - finalizeStart, '(finalize) +',
            Date.now() - createTreeStart,
            '(compute) =',
            Date.now() - initTimeStart, 'ms'
        );
    }

    return tree;
}

function buildCallTreeFor<S extends CpuProNode, D extends CpuProNode>(
    name: string,
    source: TreeSource<S>,
    dictionary: D[],
    sourceNodeToDictionaryFn: (node: S) => number
) {
    TIMINGS && console.group(`Build ${name} tree`);
    try {
        return buildCallTree(source, dictionary, sourceNodeToDictionaryFn);
    } finally {
        TIMINGS && console.groupEnd();
    }
}

function buildTreeSource(
    nodeParent: Uint32Array,
    nodeIndexById: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    callFrames: CpuProCallFrame[]
) {
    const t = Date.now();

    const treeSource = createTreeSourceFromParent(nodeParent, nodeIndexById.slice(), callFrameByNodeIndex, callFrames);

    TIMINGS && console.log('buildTreeSource()', Date.now() - t);

    return treeSource;
}

export function buildTrees(
    nodeParent: Uint32Array,
    nodeIndexById: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    dict: Dictionary
) {
    const treeSource = buildTreeSource(
        nodeParent,
        nodeIndexById,
        callFrameByNodeIndex,
        dict.callFrames
    );

    const callFramesTree = buildCallTreeFor('callFrames', treeSource, dict.callFrames, callFrame => callFrame.id - 1);
    const modulesTree = buildCallTreeFor('modules', callFramesTree, dict.modules, callFrame => callFrame.module.id - 1);
    const packagesTree = buildCallTreeFor('packages', modulesTree, dict.packages, callFrame => callFrame.package.id - 1);
    const categoriesTree = buildCallTreeFor('categories', packagesTree, dict.categories, callFrame => callFrame.category.id - 1);

    return {
        treeSource,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    };
}
