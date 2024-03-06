import { TIMINGS } from './const';
import { CallTree } from './call-tree.js';
import { CpuProArea, CpuProCallFrame, CpuProFunction, CpuProHierarchyNode, CpuProModule, CpuProNode, CpuProPackage } from './types.js';
import { makeFirstNextArrays } from './build-trees-wasm-wrapper.js';
import { buildCallTreeAndCompareWithBaseline } from './build-trees-baseline.js';

const compareWithBaseline = false;

function finalizeArrays(
    count: number,
    dictSize: number,
    firstChild: Uint32Array,
    nextSibling: Uint32Array,
    sourceToNode: Uint32Array,
    sourceToDictionary: Uint32Array,
    sourceNodes: Uint32Array
) {
    const nodes = new Uint32Array(count);
    const parent = new Uint32Array(count);
    const subtreeSize = new Uint32Array(count);
    const nested = new Uint32Array(count);
    const nestedMask = new Uint32Array(dictSize);
    const remap = new Uint32Array(count);
    let index = 0;
    let cursor = 0;

    do {
        const valueIndex = sourceToDictionary[sourceNodes[cursor]];
        const nestedLevel = nestedMask[valueIndex];
        const first = firstChild[cursor];
        let next = nextSibling[cursor];
        let nodeIndex = index++;

        nodes[nodeIndex] = cursor;
        remap[sourceToNode[cursor]] = nodeIndex;

        if (nestedLevel !== 0) {
            nested[nodeIndex] = nestedLevel;
        }

        if (first !== 0) {
            cursor = first;
            parent[index] = nodeIndex;
            nestedMask[valueIndex]++;
        } else if (next !== 0) {
            cursor = next;
            parent[index] = parent[nodeIndex];
        } else {
            cursor = 0;
            while (nodeIndex = parent[nodeIndex]) {
                nestedMask[sourceToDictionary[sourceNodes[nodes[nodeIndex]]]]--;
                if (next = nextSibling[nodes[nodeIndex]]) {
                    parent[index] = parent[nodeIndex];
                    cursor = next;
                    break;
                }
            }
        }
    } while (cursor !== 0);

    nodes[0] = sourceToDictionary[sourceNodes[nodes[0]]];
    for (let i = nodes.length - 1; i > 0; i--) {
        subtreeSize[parent[i]] += subtreeSize[i] + 1;
        nodes[i] = sourceToDictionary[sourceNodes[nodes[i]]];
    }

    for (let i = 0; i < sourceToNode.length; i++) {
        sourceToNode[i] = remap[sourceToNode[i]];
    }

    return { nodes, parent, subtreeSize, nested };
}

export function buildCallTree<S extends CpuProNode, D extends CpuProHierarchyNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    const initTimeStart = Date.now();
    const sourceNodes = sourceTree.nodes;
    const sourceToDictionary = new Uint32Array(sourceTree.dictionary.length);
    const sourceToNode = new Uint32Array(sourceNodes.length);
    const { firstChild, nextSibling } = makeFirstNextArrays(sourceTree.parent, sourceTree.subtreeSize);
    const valueToNodeEpoch = new Uint32Array(dictionary.length);
    const valueToNode = new Uint32Array(dictionary.length);
    const stack = [0];
    let nodesCount = 1;

    for (let i = 0; i < sourceTree.dictionary.length; i++) {
        sourceToDictionary[i] = dictionaryIndexBySourceTreeNode(sourceTree.dictionary[i]);
    }

    const rollupTreeStart = Date.now();
    while (stack.length > 0) {
        const nodeIndex = stack.pop();
        const nodeValue = sourceToDictionary[sourceNodes[nodeIndex]];

        let prevCursor = nodeIndex;
        let cursor = firstChild[nodeIndex];
        while (cursor !== 0) {
            const childValue = sourceToDictionary[sourceNodes[cursor]];

            if (childValue === nodeValue) {
                const cursorFirstChild = firstChild[cursor];

                sourceToNode[cursor] = sourceToNode[nodeIndex];

                if (prevCursor === nodeIndex) {
                    firstChild[prevCursor] = cursorFirstChild || nextSibling[cursor];
                } else {
                    nextSibling[prevCursor] = cursorFirstChild || nextSibling[cursor];
                }

                if (cursorFirstChild) {
                    if (nextSibling[cursor]) {
                        let lastChild = cursorFirstChild;

                        while (nextSibling[lastChild] !== 0) {
                            lastChild = nextSibling[lastChild];
                        }

                        nextSibling[lastChild] = nextSibling[cursor];
                    }

                    cursor = cursorFirstChild;
                    continue;
                }
                // when no children just ignore
            } else {
                if (valueToNodeEpoch[childValue] === nodeIndex + 1) {
                    // node already created, move children to existing node if any
                    const cursorFirstChild = firstChild[cursor];
                    const existedCursor = valueToNode[childValue];

                    sourceToNode[cursor] = sourceToNode[existedCursor];
                    nextSibling[prevCursor] = nextSibling[cursor];

                    if (cursorFirstChild) {
                        const existedFirstChild = firstChild[existedCursor];

                        if (existedFirstChild !== 0) {
                            // attach children to the end of existed (for parity with initial approach)
                            // let lastChild = existedFirstChild;

                            // while (nextSibling[lastChild] !== 0) {
                            //     lastChild = nextSibling[lastChild];
                            // }

                            // nextSibling[lastChild] = cursorFirstChild;

                            // attach children into the beginning of existed node (faster)
                            // in this case, the children will be traversed only once, unlike inserting at the end, when the complexity can be n^2
                            let lastChild = cursorFirstChild;

                            while (nextSibling[lastChild] !== 0) {
                                lastChild = nextSibling[lastChild];
                            }

                            firstChild[existedCursor] = cursorFirstChild;
                            nextSibling[lastChild] = existedFirstChild;
                        } else {
                            firstChild[existedCursor] = cursorFirstChild;
                            stack.push(existedCursor);
                        }
                    }
                } else {
                    // create new
                    sourceToNode[cursor] = nodesCount++;
                    valueToNodeEpoch[childValue] = nodeIndex + 1;
                    valueToNode[childValue] = cursor;
                    prevCursor = cursor;

                    if (firstChild[cursor]) {
                        stack.push(cursor);
                    }
                }
            }

            cursor = nextSibling[cursor];
        }
    }

    const finalizeStart = Date.now();
    const { nodes, parent, subtreeSize, nested } = finalizeArrays(
        nodesCount,
        dictionary.length,
        firstChild,
        nextSibling,
        sourceToNode,
        sourceToDictionary,
        sourceNodes
    );

    if (TIMINGS) {
        console.info(
            '---> buildTree()',
            rollupTreeStart - initTimeStart, '+',
            finalizeStart - rollupTreeStart, '+',
            Date.now() - finalizeStart,
            '=',
            Date.now() - initTimeStart, 'ms'
        );
    }

    return new CallTree(dictionary, sourceToNode, nodes, parent, subtreeSize, nested);
}

function buildCallTreeFor<S extends CpuProNode, D extends CpuProHierarchyNode>(
    name: string,
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    console.group(`Build tree for ${name}`);
    try {
        return compareWithBaseline
            ? buildCallTreeAndCompareWithBaseline(sourceTree, dictionary, dictionaryIndexBySourceTreeNode).tree
            : buildCallTree(sourceTree, dictionary, dictionaryIndexBySourceTreeNode);
    } finally {
        console.groupEnd();
    }
}

export function buildTrees(
    callFramesTree: CallTree<CpuProCallFrame>,
    functions: CpuProFunction[],
    modules: CpuProModule[],
    packages: CpuProPackage[],
    areas: CpuProArea[]
) {
    const functionsTree = buildCallTreeFor('functions', callFramesTree, functions, callFrame => callFrame.function.id - 1);
    const modulesTree = buildCallTreeFor('modules', functionsTree, modules, callFrame => callFrame.module.id - 1);
    const packagesTree = buildCallTreeFor('packages', modulesTree, packages, callFrame => callFrame.package.id - 1);
    const areasTree = buildCallTreeFor('areas', packagesTree, areas, callFrame => callFrame.area.id - 1);

    return {
        functionsTree,
        modulesTree,
        packagesTree,
        areasTree
    };
}
