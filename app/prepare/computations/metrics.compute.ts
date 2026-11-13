import { createComputeScratch, wasmBacked, type WasmExports } from './compute-wasm.js';
import type { CallTree } from './call-tree.js';
import type { SampledTree } from './metrics.js';
import metricsWasm from './metrics.compute.wasm';

// Metrics of the nodes of a tree: samples land on nodes through sampleToNode. Counts are Uint32; sums of event values
// are Float64, exact up to 2^53
export type TreeMetricsMap<T> = {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Float64Array;
    nestedValues: Float64Array;
};

// Metrics of the entries of a tree's dictionary (calls of a function, a module...): samples land on entries through
// sampleIdToDict, the totals of entries sum the nodes not nested in a node of the same entry (totalNodes)
export type DictionaryMetricsMap<T> = {
    dictionary: T[];
    sampleIdToDict: Uint32Array;
    totalNodes: Uint32Array;
    totalNodeToDict: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Float64Array;
    totalValues: Float64Array;
};

export type DimensionMaps<T> = {
    treeMap: TreeMetricsMap<T>;
    dictMap: DictionaryMetricsMap<T>;
};

const layoutScratch = createComputeScratch();

// Metrics of a tree, and of its dictionary when given, from the metrics of samples: the maps and the metrics of samples
// are staged into the scratch buffer and the metrics of nodes and entries copied out
export function computeMetrics<T>(
    sourceCounts: Uint32Array,
    sourceValues: Float64Array,
    treeMap: TreeMetricsMap<T>,
    dictMap: DictionaryMetricsMap<T> | null
) {
    const buffer = layoutMetricsBuffer(sourceCounts.length, treeMap, dictMap);
    const api = metricsApiOf(buffer);

    buffer.sourceCounts.set(sourceCounts);
    buffer.sourceValues.set(sourceValues);
    buffer.sampleToNode.set(treeMap.sampleToNode);
    buffer.parent.set(treeMap.tree.parent);
    buffer.nodeCounts.fill(0);
    buffer.nodeSelfValues.fill(0);
    buffer.nodeNestedValues.fill(0);
    api.accumulateMetrics(
        buffer.sourceCounts,
        buffer.sourceValues,
        buffer.sampleToNode,
        buffer.nodeCounts,
        buffer.nodeSelfValues
    );
    api.rollupTreeMetrics(buffer.parent, buffer.nodeSelfValues, buffer.nodeNestedValues);
    treeMap.samplesCount.set(buffer.nodeCounts);
    treeMap.selfValues.set(buffer.nodeSelfValues);
    treeMap.nestedValues.set(buffer.nodeNestedValues);

    if (dictMap !== null) {
        buffer.sampleIdToDict.set(dictMap.sampleIdToDict);
        buffer.totalNodes.set(dictMap.totalNodes);
        buffer.totalNodeToDict.set(dictMap.totalNodeToDict);
        buffer.entryCounts.fill(0);
        buffer.entrySelfValues.fill(0);
        buffer.entryTotalValues.fill(0);
        api.accumulateMetrics(
            buffer.sourceCounts,
            buffer.sourceValues,
            buffer.sampleIdToDict,
            buffer.entryCounts,
            buffer.entrySelfValues
        );
        api.rollupDictionaryMetrics(
            buffer.totalNodes,
            buffer.nodeSelfValues,
            buffer.nodeNestedValues,
            buffer.totalNodeToDict,
            buffer.entryTotalValues
        );
        dictMap.samplesCount.set(buffer.entryCounts);
        dictMap.selfValues.set(buffer.entrySelfValues);
        dictMap.totalValues.set(buffer.entryTotalValues);
    }
}

// The metrics of samples, the maps of a tree and of its dictionary (empty without one), and their metrics
function layoutMetricsBuffer<T>(
    sampleCount: number,
    treeMap: TreeMetricsMap<T>,
    dictMap: DictionaryMetricsMap<T> | null
) {
    const nodeCount = treeMap.selfValues.length;
    const entryCount = dictMap?.selfValues.length ?? 0;

    return layoutScratch({
        sourceValues: [Float64Array, sampleCount],
        nodeSelfValues: [Float64Array, nodeCount],
        nodeNestedValues: [Float64Array, nodeCount],
        entrySelfValues: [Float64Array, entryCount],
        entryTotalValues: [Float64Array, entryCount],
        sourceCounts: [Uint32Array, sampleCount],
        sampleToNode: [Uint32Array, treeMap.sampleToNode.length],
        parent: [Uint32Array, treeMap.tree.parent.length],
        nodeCounts: [Uint32Array, nodeCount],
        sampleIdToDict: [Uint32Array, dictMap?.sampleIdToDict.length ?? 0],
        totalNodes: [Uint32Array, dictMap?.totalNodes.length ?? 0],
        totalNodeToDict: [Uint32Array, dictMap?.totalNodeToDict.length ?? 0],
        entryCounts: [Uint32Array, entryCount]
    });
}

type MetricsApi = typeof metricsJavaScriptApi;

// Passes of metrics.compute.wat over the scratch buffer: self metrics of nodes or dictionary entries from the metrics
// of samples (dest[map[i]] += source[i] for counts and values), then nested values of nodes and total values
// of dictionary entries
const metricsJavaScriptApi = {
    accumulateMetrics,
    rollupTreeMetrics,
    rollupDictionaryMetrics
};
const metricsApiOf = wasmBacked(metricsWasm, metricsJavaScriptApi, bindMetricsWasm);

function accumulateMetrics(
    sourceCounts: Uint32Array,
    sourceValues: Float64Array,
    map: Uint32Array,
    destCounts: Uint32Array,
    destValues: Float64Array
) {
    for (let i = sourceCounts.length - 1; i >= 0; i--) {
        destCounts[map[i]] += sourceCounts[i];
        destValues[map[i]] += sourceValues[i];
    }
}

function rollupTreeMetrics(parent: Uint32Array, selfValues: Float64Array, nestedValues: Float64Array) {
    for (let i = parent.length - 1; i > 0; i--) {
        nestedValues[parent[i]] += selfValues[i] + nestedValues[i];
    }
}

function rollupDictionaryMetrics(
    totalNodes: Uint32Array,
    nodeSelfValues: Float64Array,
    nodeNestedValues: Float64Array,
    totalNodeToDict: Uint32Array,
    totalValues: Float64Array
) {
    for (let i = totalNodes.length - 1; i >= 0; i--) {
        const nodeId = totalNodes[i];
        const selfValue = nodeSelfValues[nodeId];
        const nestedValue = nodeNestedValues[nodeId];

        totalValues[totalNodeToDict[i]] += selfValue + nestedValue;
    }
}

function bindMetricsWasm(
    wasm: WasmExports<'accumulateMetrics' | 'rollupTreeMetrics' | 'rollupDictionaryMetrics'>
): MetricsApi {
    return {
        accumulateMetrics(sourceCounts, sourceValues, map, destCounts, destValues) {
            wasm.accumulateMetrics(
                sourceCounts.length,
                sourceCounts.byteOffset,
                sourceValues.byteOffset,
                map.byteOffset,
                destCounts.byteOffset,
                destValues.byteOffset
            );
        },
        rollupTreeMetrics(parent, selfValues, nestedValues) {
            wasm.rollupTreeMetrics(
                parent.byteOffset,
                parent.length,
                selfValues.byteOffset,
                nestedValues.byteOffset
            );
        },
        rollupDictionaryMetrics(totalNodes, nodeSelfValues, nodeNestedValues, totalNodeToDict, totalValues) {
            wasm.rollupDictionaryMetrics(
                totalNodes.length,
                totalNodes.byteOffset,
                nodeSelfValues.byteOffset,
                nodeNestedValues.byteOffset,
                totalNodeToDict.byteOffset,
                totalValues.byteOffset
            );
        }
    };
}

// Maps and metrics of a dimension of a breakdown for every sampled tree. Nodes of a tree that are not nested in a node
// of the same dictionary entry give the totals of the entries
// PERF: The maps to dictionary entries are filled by indexed loops, rather than made by TypedArray#map with a callback,
// for hundreds of thousands of samples and nodes of every tree of a breakdown
export function createSampleBreakdownMaps<T>(trees: SampledTree<T>[]) {
    const dimensions: DimensionMaps<T>[] = [];

    for (let i = 0; i < trees.length; i++) {
        const { tree, sampleToNode } = trees[i];
        const { nodes, nested } = tree;
        const nodeCount = nodes.length;
        const entryCount = tree.dictionary.length;
        const sampleIdToDict = new Uint32Array(sampleToNode.length);
        let totalNodesCount = 0;

        for (let j = 0; j < sampleToNode.length; j++) {
            sampleIdToDict[j] = nodes[sampleToNode[j]];
        }

        for (let j = 0; j < nested.length; j++) {
            if (nested[j] === 0) {
                totalNodesCount++;
            }
        }

        const totalNodes = new Uint32Array(totalNodesCount);
        const totalNodeToDict = new Uint32Array(totalNodesCount);
        let k = 0;

        for (let j = 0; j < nodeCount; j++) {
            if (nested[j] === 0) {
                totalNodes[k] = j;
                totalNodeToDict[k] = nodes[j];
                k++;
            }
        }

        dimensions.push({
            treeMap: {
                tree,
                sampleToNode,
                samplesCount: new Uint32Array(nodeCount),
                selfValues: new Float64Array(nodeCount),
                nestedValues: new Float64Array(nodeCount)
            },
            dictMap: {
                dictionary: tree.dictionary,
                sampleIdToDict,
                totalNodes,
                totalNodeToDict,
                samplesCount: new Uint32Array(entryCount),
                selfValues: new Float64Array(entryCount),
                totalValues: new Float64Array(entryCount)
            }
        });
    }

    return dimensions;
}
