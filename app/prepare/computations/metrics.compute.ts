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
// (dest[map[i]] += source[i]), then nested values of nodes and total values of dictionary entries
export const metricsJavaScriptApi = {
    accumulateCounts: accumulateMetrics<Uint32Array>,
    accumulateValues: accumulateMetrics<Float64Array>,
    rollupTreeMetrics,
    rollupDictionaryMetrics
};
export const metricsApiOf = wasmBacked(metricsWasm, metricsJavaScriptApi, bindMetricsWasm);

function accumulateMetrics<T extends Uint32Array | Float64Array>(source: T, map: Uint32Array, dest: T) {
    for (let i = source.length - 1; i >= 0; i--) {
        dest[map[i]] += source[i];
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
    wasm: WasmExports<'accumulateCounts' | 'accumulateValues' | 'rollupTreeMetrics' | 'rollupDictionaryMetrics'>
): MetricsApi {
    return {
        accumulateCounts(source, map, dest) {
            wasm.accumulateCounts(
                source.length,
                source.byteOffset,
                map.byteOffset,
                dest.byteOffset
            );
        },
        accumulateValues(source, map, dest) {
            wasm.accumulateValues(
                source.length,
                source.byteOffset,
                map.byteOffset,
                dest.byteOffset
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

    api.accumulateCounts(map.sourceSamplesCount, map.sampleToNode, map.samplesCount);
    api.accumulateValues(map.sourceSamplesTotal, map.sampleToNode, map.selfValues);
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

    api.accumulateCounts(map.sourceSamplesCount, map.sampleIdToDict, map.samplesCount);
    api.accumulateValues(map.sourceSamplesTotal, map.sampleIdToDict, map.selfValues);
    api.rollupDictionaryMetrics(
        map.totalNodes,
        map.nodeSelfValues,
        map.nodeNestedValues,
        map.totalNodeToDict,
        map.totalValues
    );
}

function createMapsFromTree<T>(sampledTree: SampledTree<T>) {
    const { tree, sampleToNode } = sampledTree;
    const { nodes, nested } = tree;
    const totalNodes = new Uint32Array(nodes.length);
    const totalNodeToDict = new Uint32Array(nodes.length);
    let k = 0;

    for (let i = 0; i < nodes.length; i++) {
        if (nested[i] === 0) {
            totalNodeToDict[k] = nodes[i];
            totalNodes[k] = i;
            k++;
        }
    }

    return {
        tree,
        sampleToNode,
        sampleIdToDict: sampleToNode.map(id => nodes[id]),
        totalNodes: totalNodes.slice(0, k),
        totalNodeToDict: totalNodeToDict.slice(0, k)
    };
}

export function createSampleBreakdownBuffer<T>(
    trees: SampledTree<T>[],
    samplesMapSize: number
) {
    const maps = trees.map(createMapsFromTree);

    // Buffer sizes: Uint32 counts and maps; Float64 sums of values, placed first to keep their 8-byte alignment
    let valuesSize =
        // samplesTotal
        samplesMapSize;
    let countsSize =
        // samplesCount
        samplesMapSize;

    for (const { tree, sampleToNode, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
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
            sampleIdToDict.length +
            totalNodes.length +
            totalNodeToDict.length +
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

    for (const { tree, sampleToNode, sampleIdToDict, totalNodes, totalNodeToDict } of maps) {
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
        const dictMap: BufferDictionaryMetricsMap<T> = {
            // input
            sourceSamplesCount: bufferMap.samplesCount,
            sourceSamplesTotal: bufferMap.samplesTotal,
            // compute support
            dictionary: tree.dictionary,
            nodeSelfValues: treeMap.selfValues,     // input from treeMap layer
            nodeNestedValues: treeMap.nestedValues, // input from treeMap layer
            sampleIdToDict: adopt(sampleIdToDict),
            totalNodes: adopt(totalNodes),
            totalNodeToDict: adopt(totalNodeToDict),
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
