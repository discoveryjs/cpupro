import { TIMINGS } from './const';
import { CallTree } from './call-tree';
import { CpuProArea, CpuProCallFrame, CpuProFunction, CpuProModule, CpuProPackage } from './types';

type HierarhyTree = Map<number, Map<number, number>>;
type CallTreeNode = CpuProArea | CpuProPackage | CpuProModule | CpuProFunction;

function rollupTree<T>(
    // input
    inputTree: CallTree<T>,
    // output
    indexBySource: number[] | Uint32Array,
    outputNodes: number[],
    hierarhyTree: HierarhyTree,
    // state
    cursor = 0,
    parentValue = 0,
    parentValueNode = 0
) {
    const value = indexBySource[cursor];
    let valueNode: number | undefined = parentValueNode;

    if (value !== parentValue) {
        let childByValueMap = hierarhyTree.get(parentValueNode);
        if (childByValueMap === undefined) {
            hierarhyTree.set(parentValueNode, childByValueMap = new Map());
        }

        valueNode = childByValueMap.get(value);
        if (valueNode === undefined) {
            childByValueMap.set(value, valueNode = outputNodes.length);
            outputNodes.push(value);
        }
    }

    indexBySource[cursor] = valueNode;

    cursor = inputTree.firstChild[cursor];
    while (cursor !== 0) {
        // console.log('>>', tree.nodes[cursor].id);
        rollupTree(
            inputTree,
            indexBySource,
            outputNodes,
            hierarhyTree,
            cursor,
            value,
            valueNode
        );
        cursor = inputTree.nextSibling[cursor];
    }
}

function callTreeFrom<T>(
    hierarhyTree: HierarhyTree,
    callTree: CallTree<T>,
    nested = new Uint32Array(callTree.dictionary.length),
    node = 0
) {
    const value = callTree.nodes[node];
    const childByValueMap = hierarhyTree.get(node);
    const valueNested = nested[value];

    if (valueNested !== 0) {
        callTree.nested[node] = valueNested;
    }

    if (childByValueMap !== undefined) {
        let prevChildIndex = 0;

        nested[value] = node;

        for (const childNode of childByValueMap.values()) {
            callTree.parent[childNode] = node;

            if (prevChildIndex === 0) {
                callTree.firstChild[node] = childNode;
            } else {
                callTree.nextSibling[prevChildIndex] = childNode;
            }

            callTreeFrom(hierarhyTree, callTree, nested, childNode);
            prevChildIndex = childNode;
        }

        nested[value] = valueNested;
    }
}

// indexBySource
//   input.nodes[] -> nodes[]
// nodes
// hierarhyTree
//   value -> index in nodes[]
function buildTree<S extends CpuProCallFrame | CallTreeNode, D extends CallTreeNode>(
    sourceTree: CallTree<S>,
    dictionary: D[],
    dictionaryIndexBySourceTreeNode: (node: S) => number
) {
    const t1 = Date.now();
    // on the beginning index contains [source index] -> [dictionary index]
    // later it remaps into [source index] -> [order index]
    const indexBySource = sourceTree.nodes.map((index: number) =>
        dictionaryIndexBySourceTreeNode(sourceTree.dictionary[index])
    );
    const outputNodes = [dictionaryIndexBySourceTreeNode(sourceTree.dictionary[sourceTree.mapToIndex[1]])];
    const hierarhyTree: HierarhyTree = new Map();

    const t2 = Date.now();
    rollupTree(
        // input
        sourceTree,
        // output
        indexBySource,
        outputNodes,
        hierarhyTree
    );

    const t3 = Date.now();
    const outputTree = new CallTree(dictionary, indexBySource, new Uint32Array(outputNodes));
    callTreeFrom(hierarhyTree, outputTree);

    if (TIMINGS) {
        console.log('---> buildTree', t2 - t1, t3 - t2, Date.now() - t3);
    }

    return outputTree;
}

function computeTimings<T extends CallTreeNode>(samples: number[], timeDeltas: number[], tree: CallTree<T>) {
    const t = Date.now();
    const selfTimes = new Uint32Array(tree.nodes.length);
    const totalTimes = new Uint32Array(tree.nodes.length);

    for (let i = 0; i < samples.length; i++) {
        selfTimes[tree.mapToIndex[samples[i]]] += timeDeltas[i];
    }

    for (let i = tree.nodes.length - 1; i > 0; i--) {
        const totalTime = selfTimes[i] + totalTimes[i];

        totalTimes[i] = totalTime;
        totalTimes[tree.parent[i]] += totalTime;
    }

    for (let i = 0; i < tree.nodes.length; i++) {
        const fn = tree.dictionary[tree.nodes[i]];
        fn.selfTime += selfTimes[i];
        if (tree.nested[i] === 0) {
            fn.totalTime += totalTimes[i];
        }
    }

    if (TIMINGS) {
        console.log(Date.now() - t);
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
    const t1 = Date.now();
    const areasTree = buildTree(callFramesTree, areas, callFrame => callFrame.area.id - 1);
    TIMINGS && console.log('>>> areas', Date.now() - t1);

    const t2 = Date.now();
    const packagesTree = buildTree(callFramesTree, packages, callFrame => callFrame.package.id - 1);
    TIMINGS && console.log('>>> packages', Date.now() - t2);

    const t3 = Date.now();
    const modulesTree = buildTree(callFramesTree, modules, callFrame => callFrame.module.id - 1);
    TIMINGS && console.log('>>> modules', Date.now() - t3);

    const t4 = Date.now();
    const functionsTree = buildTree(callFramesTree, functions, callFrame => callFrame.function.id - 1);
    TIMINGS && console.log('>>> functions', Date.now() - t4);

    for (let i = 0; i < 1; i++) {
        const t = Date.now();
        computeTimings(samples, timeDeltas, areasTree);
        computeTimings(samples, timeDeltas, packagesTree);
        computeTimings(samples, timeDeltas, modulesTree);
        computeTimings(samples, timeDeltas, functionsTree);
        TIMINGS && console.log('>>> computeTimings', Date.now() - t);
    }

    return {
        areasTree,
        packagesTree,
        modulesTree,
        functionsTree
    };
}
