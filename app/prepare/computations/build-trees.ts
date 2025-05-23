import { TIMINGS } from '../const.js';
import { CallTree } from './call-tree.js';
import type { CpuProCallFrame, CpuProCallFramePosition, CpuProNode } from '../types.js';
import type { Dictionary } from '../dictionary.js';
import type { Usage } from '../usage.js';

interface BuildTreeSource<S> {
    dictionary: S[];
    parent: Uint32Array;
    nodes: Uint32Array;
}

interface TreeSource<S> extends BuildTreeSource<S> {
    sourceIdToNode: Int32Array;
}

export function createTreeSourceFromParent<S>(
    parent: Uint32Array,
    sourceIdToNode: Int32Array,
    nodes: Uint32Array,
    dictionary: S[]
): TreeSource<S> {
    const nodeToSourceId = new Int32Array(parent.length).fill(-1);
    const computedSourceIdToNode = new Int32Array(sourceIdToNode.length).fill(-1);
    const { firstChild, nextSibling } = firstNextFromParent(parent);
    const { nodes: computedNodes, parent: computedParent } = nodesParentFromFirstNext(firstChild, nextSibling);

    for (let id = 0; id < sourceIdToNode.length; id++) {
        const index = sourceIdToNode[id];

        if (index !== -1) {
            nodeToSourceId[index] = id;
        }
    }

    for (let i = 0; i < parent.length; i++) {
        const sourceId = nodeToSourceId[computedNodes[i]];

        if (sourceId !== -1) {
            computedSourceIdToNode[sourceId] = i;
        }

        computedNodes[i] = nodes[computedNodes[i]];
    }

    return {
        dictionary,
        sourceIdToNode: computedSourceIdToNode,
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
    sourceNodeMap: Uint32Array,
    sourceDictionaryMap: Uint32Array
) {
    const remap = new Uint32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        remap[sourceNodeMap[nodes[i]]] = i;
        nodes[i] = sourceDictionaryMap[sourceNodes[nodes[i]]];
    }

    for (let i = 0; i < sourceNodeMap.length; i++) {
        sourceNodeMap[i] = remap[sourceNodeMap[i]];
    }
}

function finalizeArrays(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceNodeMap: Uint32Array,
    sourceDictionaryMap: Uint32Array,
    nodesSize: number,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    const nodes = new Uint32Array(nodesSize);
    const parent = new Uint32Array(nodesSize);
    const subtreeSize = new Uint32Array(nodesSize);
    const nested = new Uint32Array(nodesSize);

    nodesParentFromFirstNext(firstChild, nextSibling, nodes, parent);
    remapNodes(nodes, sourceNodes, sourceNodeMap, sourceDictionaryMap);
    subtreeFromParent(parent, subtreeSize);
    nestedFromNodesSubtree(nodes, subtreeSize, dictionarySize, nested);

    return { nodes, parent, subtreeSize, nested };
}

function rollupTreeByCommonValues(
    dictionarySize: number,
    sourceNodes: Uint32Array,
    sourceNodeMap: Uint32Array,
    sourceDictionaryMap: Uint32Array,
    firstChild: Uint32Array,
    nextSibling: Uint32Array
) {
    const valueToNodeEpoch = new Uint32Array(dictionarySize);
    const valueToNode = new Uint32Array(dictionarySize);
    const valueToNodeTail = new Uint32Array(dictionarySize);
    let nodesCount = 1;

    for (let i = 0; i < firstChild.length; i++) {
        const nodeIndex = i;
        const nodeValue = sourceDictionaryMap[sourceNodes[nodeIndex]];
        let prevCursor = nodeIndex;

        for (let cursor = firstChild[i]; cursor !== 0;) {
            const childValue = sourceDictionaryMap[sourceNodes[cursor]];

            if (childValue === nodeValue) {
                const cursorFirstChild = firstChild[cursor];
                const cursorNextSibling = nextSibling[cursor];

                sourceNodeMap[cursor] = sourceNodeMap[nodeIndex];

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

                    sourceNodeMap[cursor] = sourceNodeMap[existedNode];
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

                    sourceNodeMap[cursor] = nodesCount++;
                    prevCursor = cursor;
                }
            }

            cursor = nextSibling[cursor];
        }
    }

    return nodesCount;
}

const selfDictionaryMappingFn = <S, D>(value: S) => value as unknown as D;
function createDictionaryMap<S, D>(
    dictionary: S[],
    mapping: Uint32Array | ((value: S) => D) = selfDictionaryMappingFn,
    baseDictionary?: D[]
): {
    dictionary: D[],
    sourceDictionaryMap: Uint32Array
} {
    if (typeof mapping !== 'function') {
        return {
            dictionary: baseDictionary as D[],
            sourceDictionaryMap: mapping
        };
    }

    if (mapping === selfDictionaryMappingFn) {
        return {
            dictionary: dictionary as unknown as D[],
            sourceDictionaryMap: Uint32Array.from(dictionary, (_, idx) => idx)
        };
    }

    const dictionaryIndex = new Map<D, number>(baseDictionary
        ? baseDictionary.map((key, index) => [key, index])
        : undefined
    );
    const sourceDictionaryMap = Uint32Array.from(dictionary, (value) => {
        const key = mapping(value);
        let index = dictionaryIndex.get(key);

        if (index === undefined) {
            dictionaryIndex.set(key, index = dictionaryIndex.size);
        }

        return index;
    });

    return {
        dictionary: [...dictionaryIndex.keys()],
        sourceDictionaryMap: sourceDictionaryMap
    };
}

export function buildCallTreeArrays<S extends CpuProNode, D extends CpuProNode = S>(
    source: BuildTreeSource<S>,
    dictionaryMapping?: Uint32Array | ((value: S) => D),
    baseDictionary?: D[]
) {
    const initTimeStart = Date.now();
    const sourceNodes = source.nodes;
    const sourceNodeMap = new Uint32Array(sourceNodes.length);
    const { firstChild, nextSibling } = firstNextFromParent(source.parent);

    const sourceToDictStart = Date.now();
    const sourceDictionary = source.dictionary;
    const { dictionary, sourceDictionaryMap } = createDictionaryMap(
        sourceDictionary,
        dictionaryMapping,
        baseDictionary
    );

    const rollupTreeStart = Date.now();
    const nodesCount = rollupTreeByCommonValues(
        dictionary.length,
        sourceNodes,
        sourceNodeMap,
        sourceDictionaryMap,
        firstChild,
        nextSibling
    );

    const finalizeStart = Date.now();
    const { nodes, parent, subtreeSize, nested } = finalizeArrays(
        dictionary.length,
        sourceNodes,
        sourceNodeMap,
        sourceDictionaryMap,
        nodesCount,
        firstChild,
        nextSibling
    );

    return {
        sourceNodeMap,
        sourceDictionaryMap,
        dictionary,
        nodes,
        parent,
        subtreeSize,
        nested,
        timings: {
            fcns: sourceToDictStart - initTimeStart,
            dict: rollupTreeStart - sourceToDictStart,
            rollup: finalizeStart - rollupTreeStart,
            finalize: Date.now() - finalizeStart
        }
    };
}

function buildCallTree<S extends CpuProNode, D extends CpuProNode = S>(
    name: string,
    source: TreeSource<S>,
    dictionaryMapping?: Uint32Array | ((node: S) => D),
    baseDictionary?: D[]
) {
    const initTimeStart = Date.now();
    const {
        sourceNodeMap,
        dictionary,
        nodes,
        parent,
        subtreeSize,
        nested,
        timings
    } = buildCallTreeArrays(
        source,
        dictionaryMapping,
        baseDictionary
    );

    const createTreeStart = Date.now();
    const tree = new CallTree(dictionary, new Int32Array(sourceNodeMap.buffer), nodes, parent, subtreeSize, nested);

    if (TIMINGS) {
        console.info(
            `---> buildTree(${name || ''})`,
            timings.fcns, '(fc/ns) +',
            timings.dict, '(dict) +',
            timings.rollup, '(rollup) +',
            timings.finalize, '(finalize) +',
            Date.now() - createTreeStart,
            '(create tree) =',
            Date.now() - initTimeStart, 'ms'
        );
    }

    return tree;
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
    dict: Dictionary,
    nodeParent: Uint32Array,
    nodeIndexById: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    callFramePositionsTreeSource: TreeSource<CpuProCallFramePosition> | null = null,
    usage: Usage | Dictionary = dict
) {
    const treeSource = buildTreeSource(
        nodeParent,
        nodeIndexById,
        callFrameByNodeIndex,
        dict.callFrames
    );

    const callFramePositionsTree = callFramePositionsTreeSource !== null
        ? buildCallTree('callFramePositions', callFramePositionsTreeSource)
        : null;
    const callFramesTree = callFramePositionsTree !== null
        ? buildCallTree('callFrames', callFramePositionsTree, pos => pos.callFrame, usage.callFrames)
        : buildCallTree('callFrames', treeSource);
    const modulesTree = buildCallTree('modules', callFramesTree, dict.callFrameToModule, usage.modules);
    const packagesTree = buildCallTree('packages', modulesTree, dict.moduleToPackage, usage.packages);
    const categoriesTree = buildCallTree('categories', packagesTree, dict.packageToCategory, usage.categories);

    return {
        treeSource,
        callFramePositionsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    };
}
