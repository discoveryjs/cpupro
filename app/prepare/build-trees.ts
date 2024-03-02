import { TIMINGS } from './const';
import { CallTree } from './call-tree';
import { CpuProArea, CpuProCallFrame, CpuProFunction, CpuProModule, CpuProPackage } from './types';

type HierarhyTree = Map<number, Map<number, number>>;
type CallTreeNode = CpuProArea | CpuProPackage | CpuProModule | CpuProFunction;

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

function callTreeFrom<T>(
    hierarhyTree: HierarhyTree,
    callTree: CallTree<T>,
    outputNodes: number[],
    nested = new Uint32Array(callTree.dictionary.length),
    index = 0,
    cursor = 0
) {
    const childByValueMap = hierarhyTree.get(index);
    const value = outputNodes[index];
    const nodeIndex = cursor++;
    const valueNested = nested[value];

    callTree.nodes[nodeIndex] = value;
    outputNodes[index] = nodeIndex;

    if (valueNested !== 0) {
        callTree.nested[nodeIndex] = valueNested;
    }

    if (childByValueMap !== undefined) {
        nested[value] = nodeIndex;

        for (const childIndex of childByValueMap.values()) {
            callTree.parent[cursor] = nodeIndex;
            cursor = callTreeFrom(hierarhyTree, callTree, outputNodes, nested, childIndex, cursor);
        }

        callTree.subtreeSize[nodeIndex] = cursor - nodeIndex - 1;
        nested[value] = valueNested;
    }

    return cursor;
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
    // later it remaps into [source index] -> [nodes index]
    const mapDict = sourceTree.dictionary.map(dictionaryIndexBySourceTreeNode);
    const indexBySource = sourceTree.nodes.map((index: number) => mapDict[index]);
    const rootIndex = mapDict[sourceTree.nodes[0]];
    const outputNodes = [rootIndex];
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
    const outputTree = new CallTree(dictionary, indexBySource, new Uint32Array(outputNodes.length));
    callTreeFrom(hierarhyTree, outputTree, outputNodes);
    for (let i = 0; i < indexBySource.length; i++) {
        indexBySource[i] = outputNodes[indexBySource[i]];
    }

    if (TIMINGS) {
        console.log('---> buildTree', t2 - t1, t3 - t2, Date.now() - t3);
    }

    return outputTree;
}

function computeTimings<T extends CallTreeNode>(samples: number[], timeDeltas: number[], tree: CallTree<T>) {
    const t = Date.now();

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
