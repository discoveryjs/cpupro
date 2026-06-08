/* eslint-env browser */
import { base64 } from '@discoveryjs/discovery/lib/core/utils/index-script.js';
import computeMetricsWasmSourceBase64 from './metrics.wasm'; // Keep using same WASM for now
import { CallTree } from './call-tree';
import { CpuProNode } from '../types';

export type BufferDimensionMap<T> = {
    treeMap: BufferTreeMetricsMap<T>;
    dictMap: BufferDictionaryMetricsMap<T>;
};

export type BufferMap<T> = {
    memory: WebAssembly.Memory | Uint8Array | null;
    samples: BufferSamplesMetricsMap;
    dimensions: BufferDimensionMap<T>[];
};

export type BufferSamplesMetricsMap = {
    samples: Uint32Array;
    samplesMask: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;
    samplesCount: Uint32Array;
    samplesTotal: Uint32Array;
};

export type BufferTreeMetricsMap<T> = {
    tree: CallTree<T>;
    sourceSamplesCount: Uint32Array;
    sourceSamplesTotal: Uint32Array;
    sampleToNode: Uint32Array;
    parent: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Uint32Array;
    nestedValues: Uint32Array;
};

export type BufferDictionaryMetricsMap<T> = {
    dictionary: T[];
    sourceSamplesCount: Uint32Array;
    sourceSamplesTotal: Uint32Array;
    nodeSelfValues: Uint32Array;
    nodeNestedValues: Uint32Array;
    sampleIdToDict: Uint32Array;
    totalNodes: Uint32Array;
    totalNodeToDict: Uint32Array;
    samplesCount: Uint32Array;
    selfValues: Uint32Array;
    totalValues: Uint32Array;
};

type ComputeMetricsWasmModuleInstance = {
    exports: {
        accumulateSampleCount(
            srcSize: number,
            src: number,
            map: number,
            dest: number
        ): void;
        accumulateMetrics(
            srcSize: number,
            src: number,
            map: number,
            dest: number
        ): void;
        rollupTreeMetrics(
            nodesCount: number,
            parent: number,
            selfTimes: number,
            nestedTimes: number
        ): void;
        rollupDictionaryMetrics(
            totalNodesSize: number,
            totalNodes: number,
            nodeSelfTimes: number,
            nodeNestedTimes: number,
            totalNodeToDict: number,
            totalTimes: number
        ): void;
    }
}

export type ComputeMetricsApi = {
    computeMetrics(
        map: BufferSamplesMetricsMap,
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

export function createWasmApi(memory: WebAssembly.Memory | Uint8Array): ComputeMetricsApi {
    const wasmModule = createWasmModule(computeMetricsWasmSourceBase64, { memory }) as ComputeMetricsWasmModuleInstance;
    const {
        accumulateSampleCount,
        accumulateMetrics,
        rollupTreeMetrics,
        rollupDictionaryMetrics
    } = wasmModule.exports;

    return {
        computeMetrics(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.samplesTotal.fill(0);
            }

            accumulateSampleCount(
                map.values.length,
                map.values.byteOffset,
                map.samples.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateMetrics(
                map.values.length,
                map.values.byteOffset,
                map.samples.byteOffset,
                map.samplesTotal.byteOffset
            );
        },

        computeTreeMetrics(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.selfValues.fill(0);
                map.nestedValues.fill(0);
            }

            accumulateMetrics(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleToNode.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateMetrics(
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

            accumulateMetrics(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateMetrics(
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

export function createJavaScriptApi(): ComputeMetricsApi {
    function accumulateSampleCount(source: Uint32Array, map: Uint32Array, dest: Uint32Array) {
        for (let i = source.length - 1; i >= 0; i--) {
            if (source[i] !== 0) {
                dest[map[i]] += 1;
            }
        }
    }

    function accumulateMetrics(source: Uint32Array, map: Uint32Array, dest: Uint32Array) {
        for (let i = source.length - 1; i >= 0; i--) {
            dest[map[i]] += source[i];
        }
    }

    function rollupTreeMetrics(parent: Uint32Array, selfTimes: Uint32Array, nestedTimes: Uint32Array) {
        for (let i = parent.length - 1; i > 0; i--) {
            nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
        }
    }

    function rollupDictionaryMetrics(
        totalNodes: Uint32Array,
        nodeSelfTimes: Uint32Array,
        nodeNestedTimes: Uint32Array,
        totalNodeToDict: Uint32Array,
        totalTimes: Uint32Array
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

            accumulateSampleCount(values, samples, samplesCount);
            accumulateMetrics(values, samples, samplesTotal);
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
