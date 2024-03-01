import { CallTree } from './call-tree';
import { CpuProArea, CpuProCallFrame, CpuProFunction, CpuProModule, CpuProPackage } from './types';

type HierarhyTree = Map<number, Map<number, number>>;

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

function callTreeFrom<T>(hierarhyTree: HierarhyTree, callTree: CallTree<T>, node = 0) {
    const childByValueMap = hierarhyTree.get(node);

    if (childByValueMap !== undefined) {
        let prevChildIndex = 0;
        for (const childNode of childByValueMap.values()) {
            callTree.parent[childNode] = node;

            if (prevChildIndex === 0) {
                callTree.firstChild[node] = childNode;
            } else {
                callTree.nextSibling[prevChildIndex] = childNode;
            }

            callTreeFrom(hierarhyTree, callTree, childNode);
            prevChildIndex = childNode;
        }
    }
}

// indexBySource
//   input.nodes[] -> nodes[]
// nodes
// hierarhyTree
//   value -> index in nodes[]
function buildTree<T, U>(
    sourceTree: CallTree<U>,
    dictionary: T[],
    dictionaryIndexBySourceTreeNode: (x: U) => number
) {
    // on the beginning index contains [source index] -> [dictionary index]
    // later it remaps into [source index] -> [order index]
    const indexBySource = sourceTree.nodes.map(
        index => dictionaryIndexBySourceTreeNode(sourceTree.dictionary[index])
    );
    const outputNodes = [0];
    const hierarhyTree: HierarhyTree = new Map();

    rollupTree(
        // input
        sourceTree,
        // output
        indexBySource,
        outputNodes,
        hierarhyTree
    );

    const outputTree = new CallTree(dictionary, indexBySource, new Uint32Array(outputNodes));
    callTreeFrom(hierarhyTree, outputTree);

    return outputTree;
}

function xcalc(samples, timeDeltas, tree) {
    const t = Date.now();
    const selfTimes = new Uint32Array(tree.nodes.length);
    const totalTimes = new Uint32Array(tree.nodes.length);

    for (let i = 0; i < samples.length; i++) {
        selfTimes[tree.mapToIndex[samples[i]]] += timeDeltas[i];
    }

    for (let i = tree.nodes.length - 1; i >= 0; i--) {
        const idx = i;
        const totalTime = selfTimes[idx] + totalTimes[idx];

        totalTimes[idx] = totalTime;
        if (idx > 0) {
            totalTimes[tree.parent[idx]] += totalTime;
        }
    }

    const result = tree.dictionary.map(x => ({ name: x.name, selfTime: 0, totalTime: 0 }));
    for (let i = 0; i < tree.nodes.length; i++) {
        const fn = result[tree.nodes[i]];
        fn.selfTime += selfTimes[i];
        fn.totalTime = totalTimes[i];
    }
    // const test = Array.from({ length: nodeCallFrame.length }, (_, i) => {
    //     return { id: i, callFrame: callFrames[nodeCallFrame[i]], selfTime: selfTimes[i] };
    // });
    console.log(Date.now() - t);
    // console.log(result.sort((a, b) => b.selfTime - a.selfTime));
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
    console.log('>>> areas', Date.now() - t1);
    const t2 = Date.now();
    const packagesTree = buildTree(callFramesTree, packages, callFrame => callFrame.package.id - 1);
    console.log('>>> packages', Date.now() - t2);
    const t3 = Date.now();
    const modulesTree = buildTree(callFramesTree, modules, callFrame => callFrame.module.id - 1);
    console.log('>>> modules', Date.now() - t3);
    const t4 = Date.now();
    const functionsTree = buildTree(callFramesTree, functions, callFrame => callFrame.function.id - 1);
    console.log('>>> functions', Date.now() - t4);

    for (let i = 0; i < 2; i++) {
        const t = Date.now();
        xcalc(samples, timeDeltas, areasTree);
        xcalc(samples, timeDeltas, packagesTree);
        xcalc(samples, timeDeltas, modulesTree);
        xcalc(samples, timeDeltas, functionsTree);
        console.log('>>> xcalc', Date.now() - t);
    }

    return {
        areasTree,
        packagesTree,
        modulesTree,
        functionsTree
    };
}
