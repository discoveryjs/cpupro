/* eslint-env browser */
import { base64 } from '@discoveryjs/discovery/lib/core/utils/index-script.js';
import computeMetricsWasmSourceBase64 from './timings.wasm'; // Keep using same WASM for now
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
    sampleIdToNode: Uint32Array;
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
            dest: number,
            map: number
        ): void;
        accumulateTimings(
            srcSize: number,
            src: number,
            dest: number,
            map: number
        ): void;
        rollupTreeTimings(
            nodesCount: number,
            parent: number,
            selfTimes: number,
            nestedTimes: number
        ): void;
        rollupDictionaryTimings(
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
        accumulateTimings,
        rollupTreeTimings,
        rollupDictionaryTimings
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

            accumulateTimings(
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

            accumulateTimings(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToNode.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateTimings(
                map.sourceSamplesTotal.length,
                map.sourceSamplesTotal.byteOffset,
                map.sampleIdToNode.byteOffset,
                map.selfValues.byteOffset
            );

            rollupTreeTimings(
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

            accumulateTimings(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateTimings(
                map.sourceSamplesTotal.length,
                map.sourceSamplesTotal.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.selfValues.byteOffset
            );

            rollupDictionaryTimings(
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
    function accumulate(dest: Uint32Array, source: Uint32Array, map: Uint32Array) {
        for (let i = source.length - 1; i >= 0; i--) {
            dest[map[i]] += source[i];
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
            const samplesLength = samples.length;

            if (clear) {
                samplesCount.fill(0);
                samplesTotal.fill(0);
            }

            accumulate(samplesTotal, values, samples);

            for (let i = samplesLength - 1; i >= 0; i--) {
                if (values[i] !== 0) {
                    samplesCount[samples[i]]++;
                }
            }
        },

        computeTreeMetrics(map, clear = true) {
            const {
                sourceSamplesCount,
                sourceSamplesTotal,
                sampleIdToNode,
                parent,
                samplesCount,
                selfValues,
                nestedValues
            } = map;
            const nodesCount = parent.length;

            if (clear) {
                samplesCount.fill(0);
                selfValues.fill(0);
                nestedValues.fill(0);
            }

            accumulate(samplesCount, sourceSamplesCount, sampleIdToNode);
            accumulate(selfValues, sourceSamplesTotal, sampleIdToNode);

            for (let i = nodesCount - 1; i > 0; i--) {
                nestedValues[parent[i]] += selfValues[i] + nestedValues[i];
            }
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
            const nodesCount = totalNodes.length;

            if (clear) {
                samplesCount.fill(0);
                selfValues.fill(0);
                totalValues.fill(0);
            }

            accumulate(samplesCount, sourceSamplesCount, sampleIdToDict);
            accumulate(selfValues, sourceSamplesTotal, sampleIdToDict);

            for (let i = nodesCount - 1; i >= 0; i--) {
                const nodeId = totalNodes[i];
                const selfValue = nodeSelfValues[nodeId];
                const nestedValue = nodeNestedValues[nodeId];

                totalValues[totalNodeToDict[i]] += selfValue + nestedValue;
            }
        }
    };
}
