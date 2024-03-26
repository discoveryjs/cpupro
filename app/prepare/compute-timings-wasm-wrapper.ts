/* eslint-env browser */
import { decodeBase64 } from './utils';
import computeTimingsWasmSourceBase64 from './compute-timings.wasm';
import { CallTree } from './call-tree';
import { CpuProNode } from './types';

export type BufferMapRecord = { offset: number, array: Uint32Array };
export type BufferMap<T> = {
    memory: Uint32Array | WebAssembly.Memory;
    samples: BufferSamplesTimingsMap;
    tree: BufferTreeTimingsMap<T>[];
    dict: BufferDictionaryTimingsMap<T>[];
};
export type BufferSamplesTimingsMap = {
    buffer: Uint32Array;
    samples: BufferMapRecord;
    samplesMask: BufferMapRecord;
    timeDeltas: BufferMapRecord;
    timestamps: BufferMapRecord;
    samplesTimes: BufferMapRecord;
};
export type BufferTreeTimingsMap<T> = {
    buffer: Uint32Array;
    tree: CallTree<T>;
    sourceSelfTimes: BufferMapRecord;
    sampleIdToNode: BufferMapRecord;
    parent: BufferMapRecord;
    selfTimes: BufferMapRecord;
    nestedTimes: BufferMapRecord;
};
export type BufferDictionaryTimingsMap<T> = {
    buffer: Uint32Array;
    dictionary: T[];
    samplesSelfTimes: BufferMapRecord;
    nodeSelfTimes: BufferMapRecord;
    nodeNestedTimes: BufferMapRecord;
    sampleIdToDict: BufferMapRecord;
    totalNodes: BufferMapRecord;
    totalNodeToDict: BufferMapRecord;
    selfTimes: BufferMapRecord;
    totalTimes: BufferMapRecord;
};
type ComputeTimingsWasmModuleInstance = {
    exports: {
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
        accumulateTimings,
        rollupTreeTimings,
        rollupDictionaryTimings
    } = wasmModule.exports;

    return {
        computeTimings(map, clear = true) {
            if (clear) {
                map.samplesTimes.array.fill(0);
            }

            accumulateTimings(
                map.timeDeltas.array.length,
                map.timeDeltas.offset,
                map.samples.offset,
                map.samplesTimes.offset
            );
        },

        computeTreeTimings(map, clear = true) {
            if (clear) {
                map.selfTimes.array.fill(0);
                map.nestedTimes.array.fill(0);
            }

            accumulateTimings(
                map.sourceSelfTimes.array.length,
                map.sourceSelfTimes.offset,
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
                map.selfTimes.array.fill(0);
                map.totalTimes.array.fill(0);
            }

            accumulateTimings(
                map.samplesSelfTimes.array.length,
                map.samplesSelfTimes.offset,
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
    return {
        computeTimings(map, clear = true) {
            const {
                samples,
                timeDeltas,
                samplesTimes
            } = extractArrayFromMap(map);
            const samplesCount = samples.length;

            if (clear) {
                samplesTimes.fill(0);
            }

            for (let i = samplesCount - 1; i >= 0; i--) {
                samplesTimes[samples[i]] += timeDeltas[i];
            }
        },

        computeTreeTimings(map, clear = true) {
            const {
                sourceSelfTimes,
                sampleIdToNode,
                parent,
                selfTimes,
                nestedTimes
            } = extractArrayFromMap(map);
            const sourceSelfTimesSize = sourceSelfTimes.length;
            const nodesCount = selfTimes.length;

            if (clear) {
                selfTimes.fill(0);
                nestedTimes.fill(0);
            }

            for (let i = sourceSelfTimesSize - 1; i >= 0; i--) {
                selfTimes[sampleIdToNode[i]] += sourceSelfTimes[i];
            }

            for (let i = nodesCount - 1; i > 0; i--) {
                nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
            }
        },

        computeDictionaryTimings(map, clear = true) {
            const {
                samplesSelfTimes,
                nodeSelfTimes,
                nodeNestedTimes,
                sampleIdToDict,
                totalNodes,
                totalNodeToDict,
                selfTimes,
                totalTimes
            } = extractArrayFromMap(map);
            const samplesSelfTimesSize = samplesSelfTimes.length;
            const nodesCount = totalNodes.length;

            if (clear) {
                selfTimes.fill(0);
                totalTimes.fill(0);
            }

            for (let i = samplesSelfTimesSize - 1; i >= 0; i--) {
                selfTimes[sampleIdToDict[i]] += samplesSelfTimes[i];
            }

            for (let i = nodesCount - 1; i >= 0; i--) {
                const nodeId = totalNodes[i];
                const selfTime = nodeSelfTimes[nodeId];
                const nestedTime = nodeNestedTimes[nodeId];

                totalTimes[totalNodeToDict[i]] += selfTime + nestedTime;
            }
        }
    };
}
