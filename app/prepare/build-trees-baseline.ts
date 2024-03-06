import { isEqualArrays } from './build-trees-utils.js';
import { buildCallTree } from './build-trees.js';
import { CallTree } from './call-tree.js';
import { TIMINGS } from './const.js';
import { CpuProHierarchyNode, CpuProNode } from './types.js';

type HierarhyTree = Map<number, Map<number, number>>;

function rollupTree<T>(
    // input
    inputTree: CallTree<T>,
    // output
    indexBySource: CallTree<T>['mapToIndex'],
    outputNodes: number[],
    hierarhyTree: HierarhyTree,
    // state
    cursor = 0,
    parentValue = indexBySource[cursor],
    parentIndex = 0
) {
    const value = indexBySource[cursor];
    let nodeIndex: number | undefined = parentIndex;

    if (value !== parentValue) {
        let childByValueMap = hierarhyTree.get(parentIndex);
        if (childByValueMap === undefined) {
            hierarhyTree.set(parentIndex, childByValueMap = new Map());
        }

        nodeIndex = childByValueMap.get(value);
        if (nodeIndex === undefined) {
            childByValueMap.set(value, nodeIndex = outputNodes.length);
            outputNodes.push(value);
        }
    }

    indexBySource[cursor] = nodeIndex;

    const end = cursor + inputTree.subtreeSize[cursor];
    while (cursor++ < end) {
        rollupTree(
            inputTree,
            indexBySource,
            outputNodes,
            hierarhyTree,
            cursor,
            value,
            nodeIndex
        );
        cursor += inputTree.subtreeSize[cursor];
    }
}

function finalizeTree<T>(
    hierarhyTree: HierarhyTree,
    outputTree: CallTree<T>,
    outputNodes: number[],
    nested = new Uint32Array(outputTree.dictionary.length),
    index = 0,
    cursor = 0
) {
    const childByValueMap = hierarhyTree.get(index);
    const value = outputNodes[index];
    const nodeIndex = cursor++;
    const valueNested = nested[value];

    outputTree.nodes[nodeIndex] = value;
    outputNodes[index] = nodeIndex;

    if (valueNested !== 0) {
        outputTree.nested[nodeIndex] = valueNested;
    }

    if (childByValueMap !== undefined) {
        nested[value]++; // = nodeIndex;

        for (const childIndex of childByValueMap.values()) {
            outputTree.parent[cursor] = nodeIndex;
            cursor = finalizeTree(hierarhyTree, outputTree, outputNodes, nested, childIndex, cursor);
        }

        outputTree.subtreeSize[nodeIndex] = cursor - nodeIndex - 1;
        nested[value]--; // = valueNested;
    }

    return cursor;
}

// indexBySource
//   input.nodes[] -> nodes[]
// nodes
// hierarhyTree
//   value -> index in nodes[]
export function baselineBuildTree<S extends CpuProNode, D extends CpuProHierarchyNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    const initTimeStart = Date.now();
    // on the beginning index contains [source index] -> [dictionary index]
    // later it will be remaped into [source index] -> [nodes index]
    const sourceToOutputIndex = sourceTree.dictionary.map(dictionaryIndexBySourceTreeNode);
    const indexBySource = sourceTree.nodes.map((index: number) => sourceToOutputIndex[index]);
    const rootIndex = indexBySource[0];
    const outputNodes = [rootIndex];
    const hierarhyTree: HierarhyTree = new Map();

    const rollupTreeStart = Date.now();
    rollupTree(
        // input
        sourceTree,
        // output
        indexBySource,
        outputNodes,
        hierarhyTree
    );

    const finalizeStart = Date.now();
    const outputTree = new CallTree(dictionary, indexBySource, new Uint32Array(outputNodes.length));
    finalizeTree(hierarhyTree, outputTree, outputNodes);
    for (let i = 0; i < indexBySource.length; i++) {
        indexBySource[i] = outputNodes[indexBySource[i]];
    }

    if (TIMINGS) {
        console.info(
            '---> buildTree() [baseline]',
            rollupTreeStart - initTimeStart, '+',
            finalizeStart - rollupTreeStart, '+',
            Date.now() - finalizeStart,
            '=',
            Date.now() - initTimeStart, 'ms'
        );
    }

    return outputTree;
}

export function buildCallTreeAndCompareWithBaseline<S extends CpuProNode, D extends CpuProHierarchyNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    const baselineTreeBuildStart = Date.now();
    const baselineTree = baselineBuildTree(sourceTree, dictionary, dictionaryIndexBySourceTreeNode);
    const baselineTime = Date.now() - baselineTreeBuildStart;

    const buildTreeStart = Date.now();
    const tree = buildCallTree(sourceTree, dictionary, dictionaryIndexBySourceTreeNode);
    const treeTime = Date.now() - buildTreeStart;

    const diff = treeTime - baselineTime;
    const diffSign = Math.sign(diff) !== -1 ? '+' : '';
    console.info(
        'Time [baseline]:', baselineTime, 'ms',
        '\nTime:', treeTime, 'ms',
        '\nDiff:',
        diff && baselineTime && treeTime
            ? `${diffSign}${diff}ms (${diffSign}${
                Math.round(100 * diff / baselineTime)
            }%, x${
                (baselineTime / treeTime).toFixed(1).replace('.0', '')
            })`
            : diff ? `${diffSign}${diff}ms` : '–'
    );
    console.info(
        'Check arrays:',
        '\n  nodes:', isEqualArrays(baselineTree.nodes, tree.nodes),
        '\n  parent:', isEqualArrays(baselineTree.parent, tree.parent),
        '\n  nested:', isEqualArrays(baselineTree.nested, tree.nested),
        '\n  subtreeSize:', isEqualArrays(baselineTree.subtreeSize, tree.subtreeSize),
        '\n  mapToIndex:', isEqualArrays(baselineTree.mapToIndex, tree.mapToIndex)
    );

    return { baselineTree, tree };
}
