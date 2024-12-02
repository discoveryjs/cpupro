/* eslint-env browser */
import { decodeBase64 } from '../utils';
import computeTimingsWasmSourceBase64 from './timings.wasm';
import { CallTree } from './call-tree';
import { CpuProNode } from '../types';

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
    samples: Uint32Array;
    samplesMask: Uint32Array;
    timeDeltas: Uint32Array;
    timestamps: Uint32Array;
    samplesCount: Uint32Array;
    samplesTimes: Uint32Array;
};
export type BufferTreeTimingsMap<T> = {
    buffer: Uint32Array;
    tree: CallTree<T>;
    sourceSamplesCount: Uint32Array;
    sourceSamplesTimes: Uint32Array;
    sampleIdToNode: Uint32Array;
    parent: Uint32Array;
    samplesCount: Uint32Array;
    selfTimes: Uint32Array;
    nestedTimes: Uint32Array;
};
export type BufferDictionaryTimingsMap<T> = {
    buffer: Uint32Array;
    dictionary: T[];
    sourceSamplesCount: Uint32Array;
    sourceSamplesTimes: Uint32Array;
    nodeSelfTimes: Uint32Array;
    nodeNestedTimes: Uint32Array;
    sampleIdToDict: Uint32Array;
    totalNodes: Uint32Array;
    totalNodeToDict: Uint32Array;
    samplesCount: Uint32Array;
    selfTimes: Uint32Array;
    totalTimes: Uint32Array;
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
                map.samplesCount.fill(0);
                map.samplesTimes.fill(0);
            }

            accumulateSampleCount(
                map.timeDeltas.length,
                map.timeDeltas.byteOffset,
                map.samples.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateTimings(
                map.timeDeltas.length,
                map.timeDeltas.byteOffset,
                map.samples.byteOffset,
                map.samplesTimes.byteOffset
            );
        },

        computeTreeTimings(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.selfTimes.fill(0);
                map.nestedTimes.fill(0);
            }

            accumulateTimings(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToNode.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateTimings(
                map.sourceSamplesTimes.length,
                map.sourceSamplesTimes.byteOffset,
                map.sampleIdToNode.byteOffset,
                map.selfTimes.byteOffset
            );

            rollupTreeTimings(
                map.parent.byteOffset,
                map.selfTimes.length,
                map.selfTimes.byteOffset,
                map.nestedTimes.byteOffset
            );
        },

        computeDictionaryTimings(map, clear = true) {
            if (clear) {
                map.samplesCount.fill(0);
                map.selfTimes.fill(0);
                map.totalTimes.fill(0);
            }

            accumulateTimings(
                map.sourceSamplesCount.length,
                map.sourceSamplesCount.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.samplesCount.byteOffset
            );

            accumulateTimings(
                map.sourceSamplesTimes.length,
                map.sourceSamplesTimes.byteOffset,
                map.sampleIdToDict.byteOffset,
                map.selfTimes.byteOffset
            );

            rollupDictionaryTimings(
                map.totalNodes.length,
                map.totalNodes.byteOffset,
                map.nodeSelfTimes.byteOffset,
                map.nodeNestedTimes.byteOffset,
                map.totalNodeToDict.byteOffset,
                map.totalTimes.byteOffset
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
            } = map;
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
            } = map;
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
            } = map;
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
