/* eslint-env browser */
import { decodeBase64 } from '../utils';
import computeTimingsWasmSourceBase64 from './timings.wasm';
import { CallTree } from './call-tree';
import { CpuProNode } from '../types';

export type BufferMapRecord = { offset: number, array: Uint32Array };
export type BufferMap<T> = {
    memory: Uint32Array | WebAssembly.Memory;
    samples: BufferSamplesTimingsMap;
    tree: BufferTreeTimingsMap<T>[];
    dict: BufferDictionaryTimingsMap<T>[];
};
// export type BufferTreeDict = Record<string, CallTree<CpuProNode>>;
// export type BufferMap<T extends BufferTreeDict> = {
//     memory: Uint32Array | WebAssembly.Memory;
//     samples: BufferSamplesTimingsMap;
//     tree: { [K in keyof T]: BufferTreeTimingsMap<T[K] extends CallTree<infer V> ? V : never> };
//     dict: { [K in keyof T]: BufferDictionaryTimingsMap<T[K] extends CallTree<infer V> ? V : never> };
// };
export type BufferSamplesTimingsMap = {
    buffer: Uint32Array;
    samples: BufferMapRecord;
    samplesMask: BufferMapRecord;
    timeDeltas: BufferMapRecord;
    timestamps: BufferMapRecord;
    samplesCount: BufferMapRecord;
    samplesTimes: BufferMapRecord;
};
export type BufferTreeTimingsMap<T> = {
    buffer: Uint32Array;
    tree: CallTree<T>;
    sourceSamplesCount: BufferMapRecord;
    sourceSamplesTimes: BufferMapRecord;
    sampleIdToNode: BufferMapRecord;
    parent: BufferMapRecord;
    samplesCount: BufferMapRecord;
    selfTimes: BufferMapRecord;
    nestedTimes: BufferMapRecord;
};
export type BufferDictionaryTimingsMap<T> = {
    buffer: Uint32Array;
    dictionary: T[];
    sourceSamplesCount: BufferMapRecord;
    sourceSamplesTimes: BufferMapRecord;
    nodeSelfTimes: BufferMapRecord;
    nodeNestedTimes: BufferMapRecord;
    sampleIdToDict: BufferMapRecord;
    totalNodes: BufferMapRecord;
    totalNodeToDict: BufferMapRecord;
    samplesCount: BufferMapRecord;
    selfTimes: BufferMapRecord;
    totalTimes: BufferMapRecord;
};
type ComputeTimingsWasmModuleInstance = {
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
export type ComputeTimingsApi = {
    computeTimings(
        map: BufferSamplesTimingsMap,
        clear: boolean
    ): void;
    computeTreeTimings<T extends CpuProNode>(
        map: BufferTreeTimingsMap<T>,
        clear: boolean
    ): void;
    computeDictionaryTimings<T extends CpuProNode>(
        map: BufferDictionaryTimingsMap<T>,
        clear: boolean
    ): void;
};

function extractArrayFromMap<
    T extends BufferSamplesTimingsMap | BufferTreeTimingsMap<U> | BufferDictionaryTimingsMap<U>,
    U extends CpuProNode
>(map: T): Record<Exclude<keyof T, 'buffer'>, Uint32Array> {
    const result: Record<keyof T, Uint32Array> = Object.create(null);

    for (const [key, value] of Object.entries(map)) {
        if ('array' in value) {
            result[key] = value.array;
        }
    }

    return result;
}

function createWasmModule(source: string, imports = {}) {
    const sourceBytes = decodeBase64(source);
    const importObject = { imports };
    const module = new WebAssembly.Module(sourceBytes);

    return new WebAssembly.Instance(module, importObject);
}

export function createWasmApi(memory: WebAssembly.Memory): ComputeTimingsApi {
    const wasmModule = createWasmModule(computeTimingsWasmSourceBase64, { memory }) as ComputeTimingsWasmModuleInstance;
    const {
        accumulateSampleCount,
        accumulateTimings,
        rollupTreeTimings,
        rollupDictionaryTimings
    } = wasmModule.exports;

    return {
        computeTimings(map, clear = true) {
            if (clear) {
                map.samplesCount.array.fill(0);
                map.samplesTimes.array.fill(0);
            }

            accumulateSampleCount(
                map.timeDeltas.array.length,
                map.timeDeltas.offset,
                map.samples.offset,
                map.samplesCount.offset
            );

            accumulateTimings(
                map.timeDeltas.array.length,
                map.timeDeltas.offset,
                map.samples.offset,
                map.samplesTimes.offset
            );
        },

        computeTreeTimings(map, clear = true) {
            if (clear) {
                map.samplesCount.array.fill(0);
                map.selfTimes.array.fill(0);
                map.nestedTimes.array.fill(0);
            }

            accumulateTimings(
                map.sourceSamplesCount.array.length,
                map.sourceSamplesCount.offset,
                map.sampleIdToNode.offset,
                map.samplesCount.offset
            );

            accumulateTimings(
                map.sourceSamplesTimes.array.length,
                map.sourceSamplesTimes.offset,
                map.sampleIdToNode.offset,
                map.selfTimes.offset
            );

            rollupTreeTimings(
                map.parent.offset,
                map.selfTimes.array.length,
                map.selfTimes.offset,
                map.nestedTimes.offset
            );
        },

        computeDictionaryTimings(map, clear = true) {
            if (clear) {
                map.samplesCount.array.fill(0);
                map.selfTimes.array.fill(0);
                map.totalTimes.array.fill(0);
            }

            accumulateTimings(
                map.sourceSamplesCount.array.length,
                map.sourceSamplesCount.offset,
                map.sampleIdToDict.offset,
                map.samplesCount.offset
            );

            accumulateTimings(
                map.sourceSamplesTimes.array.length,
                map.sourceSamplesTimes.offset,
                map.sampleIdToDict.offset,
                map.selfTimes.offset
            );

            rollupDictionaryTimings(
                map.totalNodes.array.length,
                map.totalNodes.offset,
                map.nodeSelfTimes.offset,
                map.nodeNestedTimes.offset,
                map.totalNodeToDict.offset,
                map.totalTimes.offset
            );
        }
    };
}

export function createJavaScriptApi(): ComputeTimingsApi {
    function accumulate(dest: Uint32Array, source: Uint32Array, map: Uint32Array) {
        for (let i = source.length - 1; i >= 0; i--) {
            dest[map[i]] += source[i];
        }
    }

    return {
        computeTimings(map, clear = true) {
            const {
                samples,
                timeDeltas,
                samplesCount,
                samplesTimes
            } = extractArrayFromMap(map);
            const samplesLength = samples.length;

            if (clear) {
                samplesCount.fill(0);
                samplesTimes.fill(0);
            }

            accumulate(samplesTimes, timeDeltas, samples);

            for (let i = samplesLength - 1; i >= 0; i--) {
                if (timeDeltas[i] !== 0) {
                    samplesCount[samples[i]]++;
                }
            }
        },

        computeTreeTimings(map, clear = true) {
            const {
                sourceSamplesCount,
                sourceSamplesTimes,
                sampleIdToNode,
                parent,
                samplesCount,
                selfTimes,
                nestedTimes
            } = extractArrayFromMap(map);
            const nodesCount = selfTimes.length;

            if (clear) {
                samplesCount.fill(0);
                selfTimes.fill(0);
                nestedTimes.fill(0);
            }

            accumulate(samplesCount, sourceSamplesCount, sampleIdToNode);
            accumulate(selfTimes, sourceSamplesTimes, sampleIdToNode);

            for (let i = nodesCount - 1; i > 0; i--) {
                nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
            }
        },

        computeDictionaryTimings(map, clear = true) {
            const {
                sourceSamplesCount,
                sourceSamplesTimes,
                nodeSelfTimes,
                nodeNestedTimes,
                sampleIdToDict,
                totalNodes,
                totalNodeToDict,
                samplesCount,
                selfTimes,
                totalTimes
            } = extractArrayFromMap(map);
            const nodesCount = totalNodes.length;

            if (clear) {
                samplesCount.fill(0);
                selfTimes.fill(0);
                totalTimes.fill(0);
            }

            accumulate(samplesCount, sourceSamplesCount, sampleIdToDict);
            accumulate(selfTimes, sourceSamplesTimes, sampleIdToDict);

            for (let i = nodesCount - 1; i >= 0; i--) {
                const nodeId = totalNodes[i];
                const selfTime = nodeSelfTimes[nodeId];
                const nestedTime = nodeNestedTimes[nodeId];

                totalTimes[totalNodeToDict[i]] += selfTime + nestedTime;
            }
        }
    };
}
