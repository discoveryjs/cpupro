import { TIMINGS } from './const';
import { CallTree } from './call-tree.js';
import { CpuProCategory, CpuProCallFrame, CpuProFunction, CpuProHierarchyNode, CpuProModule, CpuProNode, CpuProPackage } from './types.js';

export function makeFirstNextArrays(parent: Uint32Array) {
    const firstChild = new Uint32Array(parent.length);
    const nextSibling = new Uint32Array(parent.length);

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

export function computeNested(
    nested: Uint32Array,
    nodes: Uint32Array,
    subtreeSize: Uint32Array,
    dictionarySize: number
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
}

export function computeSubtreeSize(
    subtreeSize: Uint32Array,
    parent: Uint32Array
) {
    for (let i = parent.length - 1; i > 0; i--) {
        subtreeSize[parent[i]] += subtreeSize[i] + 1;
    }
}

function collapseNodes(
    nodes: Uint32Array,
    parent: Uint32Array,
    sourceToNode: Uint32Array,
    remap: Uint32Array,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    let index = 0;
    let cursor = 0;

    do {
        const first = firstChild[cursor];
        let next = nextSibling[cursor];
        let nodeIndex = index++;

        nodes[nodeIndex] = cursor;
        remap[sourceToNode[cursor]] = nodeIndex;

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
}

function finalizeArrays(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceToNode: Uint32Array,
    sourceToDictionary: Uint32Array,
    nodesSize: number,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    const nodes = new Uint32Array(nodesSize);
    const parent = new Uint32Array(nodesSize);
    const subtreeSize = new Uint32Array(nodesSize);
    const nested = new Uint32Array(nodesSize);
    const remap = new Uint32Array(nodesSize);

    collapseNodes(
        nodes,
        parent,
        sourceToNode,
        remap,
        firstChild,
        nextSibling
    );

    for (let i = 0; i < nodes.length; i++) {
        nodes[i] = sourceToDictionary[sourceNodes[nodes[i]]];
    }

    computeSubtreeSize(subtreeSize, parent);
    computeNested(nested, nodes, subtreeSize, dictionarySize);

    for (let i = 0; i < sourceToNode.length; i++) {
        sourceToNode[i] = remap[sourceToNode[i]];
    }

    return { nodes, parent, subtreeSize, nested };
}

function rollupTreeByCommonValues(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceToNode: Uint32Array,
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

                sourceToNode[cursor] = sourceToNode[nodeIndex];

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

                    sourceToNode[cursor] = sourceToNode[existedNode];
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

                    sourceToNode[cursor] = nodesCount++;
                    prevCursor = cursor;
                }
            }

            cursor = nextSibling[cursor];
        }
    }

    return nodesCount;
}

export function buildCallTree<S extends CpuProNode, D extends CpuProHierarchyNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    sourceNodeToDictionaryFn: (node: S) => number
) {
    const initTimeStart = Date.now();
    const sourceNodes = sourceTree.nodes;
    const sourceToDictionary = new Uint32Array(sourceTree.dictionary.length);
    const sourceToNode = new Uint32Array(sourceNodes.length);
    const { firstChild, nextSibling } = makeFirstNextArrays(sourceTree.parent);

    const sourceToDictStart = Date.now();
    for (let i = 0; i < sourceTree.dictionary.length; i++) {
        sourceToDictionary[i] = sourceNodeToDictionaryFn(sourceTree.dictionary[i]);
    }

    const rollupTreeStart = Date.now();
    const nodesCount = rollupTreeByCommonValues(
        dictionary.length,
        sourceNodes,
        sourceToNode,
        sourceToDictionary,
        firstChild,
        nextSibling
    );

    const finalizeStart = Date.now();
    const { nodes, parent, subtreeSize, nested } = finalizeArrays(
        dictionary.length,
        sourceNodes,
        sourceToNode,
        sourceToDictionary,
        nodesCount,
        firstChild,
        nextSibling
    );

    const createTreeStart = Date.now();
    const tree = new CallTree(dictionary, sourceToNode, nodes, parent, subtreeSize, nested)
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

function buildCallTreeFor<S extends CpuProNode, D extends CpuProHierarchyNode>(
    name: string,
    sourceTree: CallTree<S>,
    dictionary: D[],
    sourceNodeToDictionaryFn: (node: S) => number
) {
    TIMINGS && console.group(`Build tree for ${name}`);
    try {
        return buildCallTree(sourceTree, dictionary, sourceNodeToDictionaryFn);
    } finally {
        TIMINGS && console.groupEnd();
    }
}

export function buildTrees(
    callFramesTree: CallTree<CpuProCallFrame>,
    functions: CpuProFunction[],
    modules: CpuProModule[],
    packages: CpuProPackage[],
    categories: CpuProCategory[]
) {
    const functionsTree = buildCallTreeFor('functions', callFramesTree, functions, callFrame => callFrame.function.id - 1);
    const modulesTree = buildCallTreeFor('modules', functionsTree, modules, callFrame => callFrame.module.id - 1);
    const packagesTree = buildCallTreeFor('packages', modulesTree, packages, callFrame => callFrame.package.id - 1);
    const categoriesTree = buildCallTreeFor('categories', packagesTree, categories, callFrame => callFrame.category.id - 1);

    return {
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    };
}
