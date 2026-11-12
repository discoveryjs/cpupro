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

// Elements of owners, offsets and contexts get their sites; the table of sites holds the site of each key
// at slots and the keys of sites at siteOwners, siteOffsets and siteContexts
export type SitesBufferMap = {
    memory: WebAssembly.Memory | Uint8Array | null;
    owners: Int32Array;
    offsets: Int32Array;
    contexts: Uint32Array;
    sites: Uint32Array;
    slots: Int32Array;
    siteOwners: Int32Array;
    siteOffsets: Int32Array;
    siteContexts: Uint32Array;
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
        findSites(
            size: number,
            owners: number,
            offsets: number,
            contexts: number,
            sites: number,
            slots: number,
            slotMask: number,
            siteOwners: number,
            siteOffsets: number,
            siteContexts: number,
            count: number
        ): number;
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
    // Sites of the first size elements, the table has room for size more sites; returns the site count
    findSites(
        map: SitesBufferMap,
        size: number,
        count: number
    ): number;
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
        rollupDictionaryMetrics,
        findSites
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
        },

        findSites(map, size, count) {
            return findSites(
                size,
                map.owners.byteOffset,
                map.offsets.byteOffset,
                map.contexts.byteOffset,
                map.sites.byteOffset,
                map.slots.byteOffset,
                map.slots.length - 1,
                map.siteOwners.byteOffset,
                map.siteOffsets.byteOffset,
                map.siteContexts.byteOffset,
                count
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
        },

        findSites(map, size, count) {
            const {
                owners,
                offsets,
                contexts,
                sites,
                slots,
                siteOwners,
                siteOffsets,
                siteContexts
            } = map;
            const slotMask = slots.length - 1;
            let owner = 0;
            let offset = 0;
            let context = 0;
            let site = 0;

            for (let i = 0; i < size; i++) {
                // An element of the previous key takes its site without a lookup
                if (i === 0 ||
                    offsets[i] !== offset ||
                    contexts[i] !== context ||
                    owners[i] !== owner) {
                    owner = owners[i];
                    offset = offsets[i];
                    context = contexts[i];

                    const homeSlot = hashSite(owner, offset, context) & slotMask;
                    let slot = homeSlot;

                    site = slots[slot];

                    while (site !== -1) {
                        if (siteOffsets[site] === offset &&
                            siteContexts[site] === context &&
                            siteOwners[site] === owner) {
                            break;
                        }

                        slot = (slot + 1) & slotMask;
                        site = slots[slot];
                    }

                    if (site === -1) {
                        site = count++;
                        siteOwners[site] = owner;
                        siteOffsets[site] = offset;
                        siteContexts[site] = context;
                        slots[slot] = site;
                    } else if (slot !== homeSlot) {
                        // PERF: A found site takes its home slot, so sites met again are found at the first probe.
                        // The site displaced from the home slot takes the found one's slot, which follows the home slot
                        // in the same run of occupied slots, so a probe from its own home slot still reaches it
                        slots[slot] = slots[homeSlot];
                        slots[homeSlot] = site;
                    }
                }

                sites[i] = site;
            }

            return count;
        }
    };
}

export function hashSite(owner: number, offset: number, context: number) {
    const key = owner ^ Math.imul(offset, 0x85ebca6b) ^ Math.imul(context, 0xc2b2ae35);
    const hash = Math.imul(key, 0x9e3779b1);

    return (hash ^ (hash >>> 16)) >>> 0;
}
