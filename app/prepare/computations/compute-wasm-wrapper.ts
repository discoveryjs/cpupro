/* eslint-env browser */
import { base64 } from '@discoveryjs/discovery/lib/core/utils/index-script.js';
import computeMetricsWasmSourceBase64 from './compute.wasm'; // Keep using same WASM for now
import { CallTree } from './call-tree';
import { CpuProNode } from '../types';

export type BufferDimensionMap<T> = {
    treeMap: BufferTreeMetricsMap<T>;
    dictMap: BufferDictionaryMetricsMap<T>;
};

// Counts are Uint32; sums of event values are Float64, exact up to 2^53
export type MetricsBufferMap<T> = {
    memory: WebAssembly.Memory | Uint8Array | null;
    samplesCount: Uint32Array;
    samplesTotal: Float64Array;
    dimensions: BufferDimensionMap<T>[];
};

export type PopulationBufferMap = {
    memory: WebAssembly.Memory | Uint8Array | null;
    samples: Uint32Array;
    values: Uint32Array;
    samplesCount: Uint32Array;
    samplesTotal: Float64Array;
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

type ComputeMetricsWasmModuleInstance = {
    exports: {
        accumulateSampleMetrics(
            srcSize: number,
            src: number,
            map: number,
            count: number,
            total: number,
            totalSize: number
        ): void;
        accumulateCounts(
            srcSize: number,
            src: number,
            map: number,
            dest: number
        ): void;
        accumulateValues(
            srcSize: number,
            src: number,
            map: number,
            dest: number
        ): void;
        rollupTreeMetrics(
            parent: number,
            nodesCount: number,
            selfValues: number,
            nestedValues: number
        ): void;
        rollupDictionaryMetrics(
            totalNodesSize: number,
            totalNodes: number,
            nodeSelfValues: number,
            nodeNestedValues: number,
            totalNodeToDict: number,
            totalValues: number
        ): void;
    }
}

export type ComputeApi = {
    computeMetrics(
        map: PopulationBufferMap,
        clear: boolean
    ): void;
    computeTreeMetrics<T extends CpuProNode>(
        map: BufferTreeMetricsMap<T>,
        clear: boolean
    ): void;
    computeDictionaryMetrics<T extends CpuProNode>(
        map: BufferDictionaryMetricsMap<T>,
        clear: boolean
    ): void;
};

function createWasmModule(source: string, imports = {}) {
    const sourceBytes = base64.decodeBytes(source);
    const importObject = { imports };
    const module = new WebAssembly.Module(sourceBytes);

    return new WebAssembly.Instance(module, importObject);
}

export function createWasmApi(memory: WebAssembly.Memory | Uint8Array): ComputeApi {
    const wasmModule = createWasmModule(computeMetricsWasmSourceBase64, { memory }) as ComputeMetricsWasmModuleInstance;
    const {
        accumulateSampleMetrics,
        accumulateCounts,
        accumulateValues,
        rollupTreeMetrics,
        rollupDictionaryMetrics
    } = wasmModule.exports;

    return {
        computeMetrics(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.samplesTotal.fill(0);
            }

            accumulateSampleMetrics(
                map.values.length,
                map.values.byteOffset,
                map.samples.byteOffset,
                map.samplesCount.byteOffset,
                map.samplesTotal.byteOffset,
                map.samplesTotal.length
            );
        },

        computeTreeMetrics(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.selfValues.fill(0);
                map.nestedValues.fill(0);
            }

            accumulateCounts(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleToNode.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateValues(
                map.sourceSamplesTotal.length,
                map.sourceSamplesTotal.byteOffset,
                map.sampleToNode.byteOffset,
                map.selfValues.byteOffset
            );

            rollupTreeMetrics(
                map.parent.byteOffset,
                map.selfValues.length,
                map.selfValues.byteOffset,
                map.nestedValues.byteOffset
            );
        },

        computeDictionaryMetrics(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.selfValues.fill(0);
                map.totalValues.fill(0);
            }

            accumulateCounts(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateValues(
                map.sourceSamplesTotal.length,
                map.sourceSamplesTotal.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.selfValues.byteOffset
            );

            rollupDictionaryMetrics(
                map.totalNodes.length,
                map.totalNodes.byteOffset,
                map.nodeSelfValues.byteOffset,
                map.nodeNestedValues.byteOffset,
                map.totalNodeToDict.byteOffset,
                map.totalValues.byteOffset
            );
        }
    };
}

export function createJavaScriptApi(): ComputeApi {
    function accumulateSampleMetrics(source: Uint32Array, map: Uint32Array, count: Uint32Array, total: Float64Array) {
        for (let i = source.length - 1; i >= 0; i--) {
            const value = source[i];

            if (value !== 0) {
                count[map[i]] += 1;
                total[map[i]] += value;
            }
        }
    }

    function accumulateMetrics<T extends Uint32Array | Float64Array>(source: T, map: Uint32Array, dest: T) {
        for (let i = source.length - 1; i >= 0; i--) {
            dest[map[i]] += source[i];
        }
    }

    function rollupTreeMetrics(parent: Uint32Array, selfTimes: Float64Array, nestedTimes: Float64Array) {
        for (let i = parent.length - 1; i > 0; i--) {
            nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
        }
    }

    function rollupDictionaryMetrics(
        totalNodes: Uint32Array,
        nodeSelfTimes: Float64Array,
        nodeNestedTimes: Float64Array,
        totalNodeToDict: Uint32Array,
        totalTimes: Float64Array
    ) {
        for (let i = totalNodes.length - 1; i >= 0; i--) {
            const nodeId = totalNodes[i];
            const selfTime = nodeSelfTimes[nodeId];
            const nestedTime = nodeNestedTimes[nodeId];

            totalTimes[totalNodeToDict[i]] += selfTime + nestedTime;
        }
    }

    return {
        computeMetrics(map, clear = true) {
            const {
                samples,
                values,
                samplesCount,
                samplesTotal
            } = map;

            if (clear) {
                samplesCount.fill(0);
                samplesTotal.fill(0);
            }

            accumulateSampleMetrics(values, samples, samplesCount, samplesTotal);
        },

        computeTreeMetrics(map, clear = true) {
            const {
                sourceSamplesCount,
                sourceSamplesTotal,
                sampleToNode,
                parent,
                samplesCount,
                selfValues,
                nestedValues
            } = map;

            if (clear) {
                samplesCount.fill(0);
                selfValues.fill(0);
                nestedValues.fill(0);
            }

            accumulateMetrics(sourceSamplesCount, sampleToNode, samplesCount);
            accumulateMetrics(sourceSamplesTotal, sampleToNode, selfValues);
            rollupTreeMetrics(parent, selfValues, nestedValues);
        },

        computeDictionaryMetrics(map, clear = true) {
            const {
                sourceSamplesCount,
                sourceSamplesTotal,
                nodeSelfValues,
                nodeNestedValues,
                sampleIdToDict,
                totalNodes,
                totalNodeToDict,
                samplesCount,
                selfValues,
                totalValues
            } = map;

            if (clear) {
                samplesCount.fill(0);
                selfValues.fill(0);
                totalValues.fill(0);
            }

            accumulateMetrics(sourceSamplesCount, sampleIdToDict, samplesCount);
            accumulateMetrics(sourceSamplesTotal, sampleIdToDict, selfValues);
            rollupDictionaryMetrics(totalNodes, nodeSelfValues, nodeNestedValues, totalNodeToDict, totalValues);
        }
    };
}
