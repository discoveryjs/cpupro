import { TIMINGS } from './const';
import { CallTree } from './call-tree.js';
import { CpuProArea, CpuProCallFrame, CpuProFunction, CpuProHierarchyNode, CpuProModule, CpuProNode, CpuProPackage } from './types.js';
import { makeFirstNextArrays } from './build-trees-wasm-wrapper.js';
import { buildTreeAndCompareWithBaseline } from './build-trees-baseline.js';

const compareWithBaseline = false;

function finalizeArrays(
    count: number,
    dictSize: number,
    firstChild: Uint32Array,
    nextSibling: Uint32Array,
    indexBySource: Uint32Array,
    cursorToValue: Uint32Array,
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
        const valueIndex = cursorToValue[sourceNodes[cursor]];
        const nestedLevel = nestedMask[valueIndex];
        const first = firstChild[cursor];
        let next = nextSibling[cursor];
        let nodeIndex = index++;

        nodes[nodeIndex] = cursor;
        remap[indexBySource[cursor]] = nodeIndex;

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
                nestedMask[cursorToValue[sourceNodes[nodes[nodeIndex]]]]--;
                if (next = nextSibling[nodes[nodeIndex]]) {
                    parent[index] = parent[nodeIndex];
                    cursor = next;
                    break;
                }
            }
        }
    } while (cursor !== 0);

    nodes[0] = cursorToValue[sourceNodes[nodes[0]]];
    for (let i = nodes.length - 1; i > 0; i--) {
        subtreeSize[parent[i]] += subtreeSize[i] + 1;
        nodes[i] = cursorToValue[sourceNodes[nodes[i]]];
    }

    for (let i = 0; i < indexBySource.length; i++) {
        indexBySource[i] = remap[indexBySource[i]];
    }

    return { nodes, parent, subtreeSize, nested };
}

export function buildTree<S extends CpuProNode, D extends CpuProHierarchyNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    const initTimeStart = Date.now();
    const sourceToOutputIndex = new Uint32Array(sourceTree.dictionary.length);
    const indexBySource = new Uint32Array(sourceTree.nodes.length);
    const { firstChild, nextSibling } = makeFirstNextArrays(sourceTree.parent, sourceTree.subtreeSize);
    const valueToNodeEpoch = new Uint32Array(dictionary.length);
    const valueToNode = new Uint32Array(dictionary.length);
    const stack = [0];
    let nodesCount = 1;

    for (let i = 0; i < sourceTree.dictionary.length; i++) {
        sourceToOutputIndex[i] = dictionaryIndexBySourceTreeNode(sourceTree.dictionary[i]);
    }

    const rollupTreeStart = Date.now();
    while (stack.length > 0) {
        const nodeIndex = stack.pop();
        const nodeValue = sourceToOutputIndex[sourceTree.nodes[nodeIndex]];

        let prevCursor = nodeIndex;
        let cursor = firstChild[nodeIndex];
        while (cursor !== 0) {
            const childValue = sourceToOutputIndex[sourceTree.nodes[cursor]];

            if (childValue === nodeValue) {
                const cursorFirstChild = firstChild[cursor];

                indexBySource[cursor] = indexBySource[nodeIndex];

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

                    indexBySource[cursor] = indexBySource[existedCursor];
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
                    indexBySource[cursor] = nodesCount++;
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
        indexBySource,
        sourceToOutputIndex,
        sourceTree.nodes
    );

    // for (let i = 0; i < nodes.length; i++) {
    //     nodes[i] = sourceToOutputIndex[sourceTree.nodes[nodes[i]]];
    // }

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

    return new CallTree(dictionary, indexBySource, nodes, parent, subtreeSize, nested);
}

function computeTimings<T extends CpuProNode>(
    name: string,
    samples: number[],
    timeDeltas: number[],
    tree: CallTree<T>
) {
    const startTime = Date.now();

    for (let i = 0; i < samples.length; i++) {
        tree.selfTimes[tree.mapToIndex[samples[i]]] += timeDeltas[i];
    }

    for (let i = tree.nodes.length - 1; i > 0; i--) {
        const selfTime = tree.selfTimes[i];
        const totalTime = selfTime + tree.nestedTimes[i];

        tree.nestedTimes[tree.parent[i]] += totalTime;

        // populare subject fields
        const subject = tree.dictionary[tree.nodes[i]];
        subject.selfTime += selfTime;
        if (tree.nested[i] === 0) {
            subject.totalTime += totalTime;
        }
    }

    if (TIMINGS) {
        console.log(`${name}:`, Date.now() - startTime);
    }
}

function buildTreeFor<S extends CpuProNode, D extends CpuProHierarchyNode>(
    name: string,
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    console.group(`Build tree for ${name}`);
    try {
        return compareWithBaseline
            ? buildTreeAndCompareWithBaseline(sourceTree, dictionary, dictionaryIndexBySourceTreeNode).tree
            : buildTree(sourceTree, dictionary, dictionaryIndexBySourceTreeNode);
    } finally {
        console.groupEnd();
    }
}

export function buildTrees(
    callFramesTree: CallTree<CpuProCallFrame>,
    areas: CpuProArea[],
    packages: CpuProPackage[],
    modules: CpuProModule[],
    functions: CpuProFunction[],
    samples: number[],
    timeDeltas: number[]
) {
    const areasTree = buildTreeFor('areas', callFramesTree, areas, callFrame => callFrame.area.id - 1);
    const packagesTree = buildTreeFor('packages', callFramesTree, packages, callFrame => callFrame.package.id - 1);
    const modulesTree = buildTreeFor('modules', callFramesTree, modules, callFrame => callFrame.module.id - 1);
    const functionsTree = buildTreeFor('functions', callFramesTree, functions, callFrame => callFrame.function.id - 1);

    TIMINGS && console.group('Compute timings');
    for (let i = 0; i < 1; i++) {
        const startTime = Date.now();

        computeTimings('areas', samples, timeDeltas, areasTree);
        computeTimings('packages', samples, timeDeltas, packagesTree);
        computeTimings('modules', samples, timeDeltas, modulesTree);
        computeTimings('functions', samples, timeDeltas, functionsTree);

        TIMINGS && console.log('Total time:', Date.now() - startTime);
    }
    TIMINGS && console.groupEnd();

    return {
        areasTree,
        packagesTree,
        modulesTree,
        functionsTree
    };
}
