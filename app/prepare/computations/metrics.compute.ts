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

// Metrics of the entries of a tree's dictionary (calls of a function, a module...): the nodes of an entry give its self
// metrics, and the nodes not nested in a node of the same entry give its total
export type DictionaryMetricsMap<T> = {
    dictionary: T[];
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
        buffer.nodeToDict.set(treeMap.tree.nodes);
        buffer.nested.set(treeMap.tree.nested);
        buffer.entryCounts.fill(0);
        buffer.entrySelfValues.fill(0);
        buffer.entryTotalValues.fill(0);
        api.accumulateMetrics(
            buffer.nodeCounts,
            buffer.nodeSelfValues,
            buffer.nodeToDict,
            buffer.entryCounts,
            buffer.entrySelfValues
        );
        api.rollupDictionaryMetrics(
            buffer.nodeToDict,
            buffer.nested,
            buffer.nodeSelfValues,
            buffer.nodeNestedValues,
            buffer.entryTotalValues
        );
        dictMap.samplesCount.set(buffer.entryCounts);
        dictMap.selfValues.set(buffer.entrySelfValues);
        dictMap.totalValues.set(buffer.entryTotalValues);
    }
}

// The metrics of samples, the maps of a tree and of its nodes to the dictionary (empty without one), and their metrics
function layoutMetricsBuffer<T>(
    sampleCount: number,
    treeMap: TreeMetricsMap<T>,
    dictMap: DictionaryMetricsMap<T> | null
) {
    const nodeCount = treeMap.selfValues.length;
    const entryCount = dictMap?.selfValues.length ?? 0;
    const dictNodeCount = dictMap !== null ? treeMap.tree.nodes.length : 0;

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
        nodeToDict: [Uint32Array, dictNodeCount],
        nested: [Uint32Array, dictNodeCount],
        entryCounts: [Uint32Array, entryCount]
    });
}

type MetricsApi = typeof metricsJavaScriptApi;

// Passes of metrics.compute.wat over the scratch buffer: self metrics of nodes from the metrics of samples, or of
// dictionary entries from the metrics of nodes (dest[map[i]] += source[i] for counts and values), then nested values
// of nodes and total values of dictionary entries
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
    nodeToDict: Uint32Array,
    nested: Uint32Array,
    nodeSelfValues: Float64Array,
    nodeNestedValues: Float64Array,
    totalValues: Float64Array
) {
    for (let i = nodeToDict.length - 1; i >= 0; i--) {
        if (nested[i] === 0) {
            totalValues[nodeToDict[i]] += nodeSelfValues[i] + nodeNestedValues[i];
        }
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
        rollupDictionaryMetrics(nodeToDict, nested, nodeSelfValues, nodeNestedValues, totalValues) {
            wasm.rollupDictionaryMetrics(
                nodeToDict.length,
                nodeToDict.byteOffset,
                nested.byteOffset,
                nodeSelfValues.byteOffset,
                nodeNestedValues.byteOffset,
                totalValues.byteOffset
            );
        }
    };
}

// Maps of a dimension of a breakdown for a sampled tree, with metric arrays of its nodes and dictionary entries
export function createDimensionMaps<T>(sampledTree: SampledTree<T>): DimensionMaps<T> {
    const { tree, sampleToNode } = sampledTree;
    const nodeCount = tree.nodes.length;
    const entryCount = tree.dictionary.length;

    return {
        treeMap: {
            tree,
            sampleToNode,
            samplesCount: new Uint32Array(nodeCount),
            selfValues: new Float64Array(nodeCount),
            nestedValues: new Float64Array(nodeCount)
        },
        dictMap: {
            dictionary: tree.dictionary,
            samplesCount: new Uint32Array(entryCount),
            selfValues: new Float64Array(entryCount),
            totalValues: new Float64Array(entryCount)
        }
    };
}
