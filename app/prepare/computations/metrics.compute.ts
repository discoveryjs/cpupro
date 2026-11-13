import { createComputeMemory, wasmBacked, type ComputeMemory, type WasmExports } from './compute-wasm.js';
import type { CallTree } from './call-tree.js';
import type { SampledTree } from './metrics.js';
import metricsWasm from './metrics.compute.wasm';

export type BufferDimensionMap<T> = {
    treeMap: BufferTreeMetricsMap<T>;
    dictMap: BufferDictionaryMetricsMap<T>;
};

// Counts are Uint32; sums of event values are Float64, exact up to 2^53
export type MetricsBufferMap<T> = {
    memory: ComputeMemory;
    samplesCount: Uint32Array;
    samplesTotal: Float64Array;
    dimensions: BufferDimensionMap<T>[];
};

export type BufferTreeMetricsMap<T> = {
    tree: CallTree<T>;
    sourceSamplesCount: Uint32Array;
    sourceSamplesTotal: Float64Array;
    sampleToNode: Uint32Array;
    parent: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Float64Array;
    nestedValues: Float64Array;
};

export type BufferDictionaryMetricsMap<T> = {
    dictionary: T[];
    sourceSamplesCount: Uint32Array;
    sourceSamplesTotal: Float64Array;
    nodeSelfValues: Float64Array;
    nodeNestedValues: Float64Array;
    sampleIdToDict: Uint32Array;
    totalNodes: Uint32Array;
    totalNodeToDict: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Float64Array;
    totalValues: Float64Array;
};

export type MetricsApi = typeof metricsJavaScriptApi;

// Passes of metrics.compute.wat: self metrics of nodes or dictionary entries from the metrics of samples
// (dest[map[i]] += source[i] for counts and values), then nested values of nodes and total values of dictionary
// entries
export const metricsJavaScriptApi = {
    accumulateMetrics,
    rollupTreeMetrics,
    rollupDictionaryMetrics
};
export const metricsApiOf = wasmBacked(metricsWasm, metricsJavaScriptApi, bindMetricsWasm);

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
                selfValues.length,
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

export function computeTreeMetrics<T>(
    api: MetricsApi,
    map: BufferTreeMetricsMap<T>,
    clear = true
) {
    if (clear) {
        map.samplesCount.fill(0);
        map.selfValues.fill(0);
        map.nestedValues.fill(0);
    }

    api.accumulateMetrics(
        map.sourceSamplesCount,
        map.sourceSamplesTotal,
        map.sampleToNode,
        map.samplesCount,
        map.selfValues
    );
    api.rollupTreeMetrics(map.parent, map.selfValues, map.nestedValues);
}

export function computeDictionaryMetrics<T>(
    api: MetricsApi,
    map: BufferDictionaryMetricsMap<T>,
    clear = true
) {
    if (clear) {
        map.samplesCount.fill(0);
        map.selfValues.fill(0);
        map.totalValues.fill(0);
    }

    api.accumulateMetrics(
        map.sourceSamplesCount,
        map.sourceSamplesTotal,
        map.sampleIdToDict,
        map.samplesCount,
        map.selfValues
    );
    api.rollupDictionaryMetrics(
        map.totalNodes,
        map.nodeSelfValues,
        map.nodeNestedValues,
        map.totalNodeToDict,
        map.totalValues
    );
}

export function createSampleBreakdownBuffer<T>(
    trees: SampledTree<T>[],
    samplesMapSize: number
) {
    // Nodes of a tree that are not nested in a node of the same dictionary entry give the totals of the entries
    const totalNodesCounts = new Uint32Array(trees.length);

    // Buffer sizes: Uint32 counts and maps; Float64 sums of values, placed first to keep their 8-byte alignment
    let valuesSize =
        // samplesTotal
        samplesMapSize;
    let countsSize =
        // samplesCount
        samplesMapSize;

    for (let i = 0; i < trees.length; i++) {
        const { tree, sampleToNode } = trees[i];
        const { nested } = tree;
        let totalNodesCount = 0;

        for (let j = 0; j < nested.length; j++) {
            if (nested[j] === 0) {
                totalNodesCount++;
            }
        }

        totalNodesCounts[i] = totalNodesCount;

        // tree metrics: selfValues, nestedValues
        valuesSize += 2 * tree.nodes.length;
        countsSize +=
            // sample-to-node map
            sampleToNode.length +
            // parent
            tree.parent.length +
            // samplesCount
            tree.nodes.length;

        // dict metrics: selfValues, totalValues
        valuesSize += 2 * tree.dictionary.length;
        countsSize +=
            // sample-to-dict map
            sampleToNode.length +
            // total nodes and their dictionary entries
            2 * totalNodesCount +
            // samplesCount
            tree.dictionary.length;
    }

    const byteSize = 8 * valuesSize + 4 * countsSize;
    const memory = createComputeMemory(byteSize);
    const values = new Float64Array(memory.buffer, 0, valuesSize);
    const counts = new Uint32Array(memory.buffer, 8 * valuesSize, countsSize);
    let valuesOffset = 0;
    let countsOffset = 0;
    const bufferMap: MetricsBufferMap<T> = {
        memory,
        samplesCount: alloc(samplesMapSize),
        samplesTotal: allocValues(samplesMapSize),
        dimensions: []
    };

    // PERF: The maps to dictionary entries are filled by indexed loops into the vectors the layout gives them, rather
    // than made by TypedArray#map with a callback and copied, for hundreds of thousands of samples and nodes of every
    // tree of a breakdown
    for (let i = 0; i < trees.length; i++) {
        const { tree, sampleToNode } = trees[i];
        const { nodes, nested } = tree;
        const treeMap: BufferTreeMetricsMap<T> = {
            // input
            sourceSamplesCount: bufferMap.samplesCount,
            sourceSamplesTotal: bufferMap.samplesTotal,
            // compute support
            tree,
            sampleToNode: adopt(sampleToNode),
            parent: adopt(tree.parent),
            // output
            samplesCount: alloc(tree.nodes.length),
            selfValues: allocValues(tree.nodes.length),
            nestedValues: allocValues(tree.nodes.length)
        };
        const sampleIdToDict = alloc(sampleToNode.length);
        const totalNodes = alloc(totalNodesCounts[i]);
        const totalNodeToDict = alloc(totalNodesCounts[i]);
        let k = 0;

        for (let j = 0; j < sampleToNode.length; j++) {
            sampleIdToDict[j] = nodes[sampleToNode[j]];
        }

        for (let j = 0; j < nodes.length; j++) {
            if (nested[j] === 0) {
                totalNodes[k] = j;
                totalNodeToDict[k] = nodes[j];
                k++;
            }
        }

        const dictMap: BufferDictionaryMetricsMap<T> = {
            // input
            sourceSamplesCount: bufferMap.samplesCount,
            sourceSamplesTotal: bufferMap.samplesTotal,
            // compute support
            dictionary: tree.dictionary,
            nodeSelfValues: treeMap.selfValues,     // input from treeMap layer
            nodeNestedValues: treeMap.nestedValues, // input from treeMap layer
            sampleIdToDict,
            totalNodes,
            totalNodeToDict,
            // output
            samplesCount: alloc(tree.dictionary.length),
            selfValues: allocValues(tree.dictionary.length),
            totalValues: allocValues(tree.dictionary.length)
        };

        bufferMap.dimensions.push({ treeMap: treeMap, dictMap: dictMap });
    }

    return bufferMap;

    function adopt(array: Uint32Array) {
        counts.set(array, countsOffset);

        return counts.subarray(countsOffset, countsOffset += array.length);
    }

    function alloc(size: number) {
        return counts.subarray(countsOffset, countsOffset += size);
    }

    function allocValues(size: number) {
        return values.subarray(valuesOffset, valuesOffset += size);
    }
}
