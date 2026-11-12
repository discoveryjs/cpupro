import { USE_WASM } from '../const.js';
import { scriptFromScriptId } from './scripts.js';
import { capacity, createUint32Progression } from '../misc/utils.js';
import {
    createJavaScriptApi,
    createWasmApi,
    hashSite,
    type ComputeApi,
    type SitesBufferMap
} from '../computations/compute-wasm-wrapper.js';
import type { Dictionary } from '../dictionary.js';
import type { TreeSource } from '../computations/build-trees.js';
import type {
    AllocationContextInfoVector,
    CpuProCallFrame,
    CpuProLocation,
    IProfileScriptsMap,
    ScriptOffsetVector
} from '../types.js';

export type VectorLocations = TreeSource<CpuProLocation> & {
    samples: Uint32Array;
};

// Locations of samples and of their call tree: a node of the call tree is located at the script offset of its call
// in the parent's call frame, and a sample at its script offset in its node's call frame. A location combines
// a call frame, a script offset and the line and column of the offset when the source is available. Samples become
// samples of location nodes added after the call tree nodes, a node per sampled node and script offset.
export function createLocationsFromScriptOffsets(
    dict: Dictionary,
    nodeParent: Uint32Array,
    nodeScriptOffsets: Int32Array,
    nodeCallFrames: Uint32Array,
    samples: Uint32Array,
    sampledScriptOffsets: Int32Array | null
) {
    if (sampledScriptOffsets === null) {
        return null;
    }

    const callFrames = dict.callFrames;
    const treeNodeCount = nodeParent.length;
    // A location per site of a call frame at a script offset, resolved in the order the sites are found
    const callFrameSites = new LocationSites(treeNodeCount);
    const callFrameSiteLocations: number[] = [];

    const locationsOf = (callFrameIndices: Uint32Array, scriptOffsets: Int32Array) => {
        const locations = new Uint32Array(scriptOffsets.length);

        callFrameSites.sitesOf(callFrameIndices, scriptOffsets, null, locations);

        for (let i = callFrameSiteLocations.length; i < callFrameSites.count; i++) {
            callFrameSiteLocations.push(dict.resolveLocationIndex(
                callFrames[callFrameSites.owners[i]],
                null,
                callFrameSites.offsets[i]
            ));
        }

        for (let i = 0; i < locations.length; i++) {
            locations[i] = callFrameSiteLocations[locations[i]];
        }

        return locations;
    };

    // The location of a node is the script offset of its call in the parent's call frame
    const treeLocations = locationsOf(callFramesOfNodes(nodeCallFrames, nodeParent), nodeScriptOffsets);

    // A sample becomes a sample of the site of its node at its script offset, the site is located
    // at the script offset in the node's call frame
    const sampleSites = new LocationSites(Math.min(samples.length, 1 << 12));

    sampleSites.sitesOf(samples, sampledScriptOffsets, null, samples);

    const sampleCount = sampleSites.count;
    const sampleLocations = locationsOf(
        callFramesOfNodes(nodeCallFrames, sampleSites.owners.subarray(0, sampleCount)),
        sampleSites.offsets.subarray(0, sampleCount)
    );
    const nodeCount = treeNodeCount + sampleCount;
    const nodes = new Uint32Array(nodeCount);
    const parent = new Uint32Array(nodeCount);
    const sourceIdToNode = new Int32Array(sampleCount);

    nodes.set(treeLocations);
    nodes.set(sampleLocations, treeNodeCount);
    parent.set(nodeParent);
    parent.set(sampleSites.owners.subarray(0, sampleCount), treeNodeCount);

    for (let i = 0; i < sourceIdToNode.length; i++) {
        sourceIdToNode[i] = treeNodeCount + i;
    }

    return {
        nodes,
        parent,
        sourceIdToNode,
        dictionary: dict.locations
    };
}

function callFramesMapFromDict(dict: Record<number, string>): (CpuProCallFrame | null)[] {
    const maxId = Object.keys(dict).reduce((max, key) => Math.max(max, Number(key)), 0);
    return Array.from({ length: maxId + 1 }, () => null);
}

function resolveVmStateCallFrame(
    dictionary: Dictionary,
    name: string
): CpuProCallFrame {
    return dictionary.resolveCallFrame({
        functionName: `(${name})`,
        scriptId: 0,
        url: null,
        lineNumber: -1,
        columnNumber: -1
    }, null as unknown as IProfileScriptsMap);
}

function resolveBuiltinCallFrame(
    dictionary: Dictionary,
    name: string
): CpuProCallFrame {
    return dictionary.resolveCallFrame({
        functionName: `(builtin) ${name}`,
        scriptId: 0,
        url: null,
        lineNumber: -1,
        columnNumber: -1
    }, null as unknown as IProfileScriptsMap);
}

function resolveCallFrameFromContextInfo(
    dictionary: Dictionary,
    contextInfoValue: number,
    vmStateCallFrames: (CpuProCallFrame | null)[],
    builtinsCallFrames: (CpuProCallFrame | null)[]
): CpuProCallFrame {
    let callFrame: CpuProCallFrame | null;

    if (contextInfoValue === 0) {
        // Safeguard: check we are not trying to resolve a call frame for context info value 0, which is invalid
        throw new Error('Context info value cannot be zero when resolving call frame');
    }

    if (contextInfoValue <= 0x0f) {
        callFrame = vmStateCallFrames[contextInfoValue];

        if (!callFrame) {
            // TODO: add a diagnostic here to indicate that an unknown VM state code was encountered
            callFrame = resolveVmStateCallFrame(dictionary, `unknown-vm-state[${contextInfoValue}]`);
            callFrame.kind = 'vm-state';
            vmStateCallFrames[contextInfoValue] = callFrame;
        }
    } else {
        const builtinId = contextInfoValue >>> 4;

        callFrame = builtinsCallFrames[builtinId];

        if (!callFrame) {
            // TODO: add a diagnostic here to indicate that an unknown builtin code was encountered
            callFrame = resolveBuiltinCallFrame(dictionary, `unknown-builtin[${builtinId}]`);
            builtinsCallFrames[builtinId] = callFrame;
        }
    }

    return callFrame;
}

function buildContextVmStateDict(
    dictionary: Dictionary,
    vmStateNames: Record<number, string>
) {
    const vmStateCallFrames = callFramesMapFromDict(vmStateNames);

    for (const [code, name] of Object.entries(vmStateNames)) {
        vmStateCallFrames[Number(code)] = resolveVmStateCallFrame(dictionary, name);
    }

    return vmStateCallFrames;
}

function buildContextBuiltinDict(
    dictionary: Dictionary,
    builtinsNames: Record<number, string>
) {
    const builtinsCallFrames = callFramesMapFromDict(builtinsNames);

    for (const [code, name] of Object.entries(builtinsNames)) {
        builtinsCallFrames[Number(code)] = resolveBuiltinCallFrame(dictionary, name);
    }

    return builtinsCallFrames;
}

// Call frames of the nodes; a node beyond the call frames of all nodes takes 0, as a typed array stores undefined
function callFramesOfNodes(nodeCallFrames: Uint32Array, nodes: ArrayLike<number>) {
    const callFrames = new Uint32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
        callFrames[i] = nodeCallFrames[nodes[i]];
    }

    return callFrames;
}

const emptyDict = Object.freeze({});

// Allocations repeat their sites (a script, a script offset and context info) heavily: tens of millions
// of allocations come from hundreds of thousands of sites, and every other allocation changes the site.
// A single pass numbers the sites in the order they are met through a hash table, an allocation of the previous
// site skips the lookup. The sites are the samples, so the pass doesn't resolve anything: each site is resolved
// afterwards to a node of the location tree, the node of its location, or for context info within a script,
// the child node of that location for the context. Several sites may resolve to the same node.
export function createVectorLocations(
    dictionary: Dictionary,
    scriptsMap: IProfileScriptsMap,
    scriptIds: Int32Array | null, // script ids normalized by the scripts map
    scriptOffsets: ScriptOffsetVector | null,
    contextInfo: AllocationContextInfoVector | null,
    vmStateNames: Record<number, string> | null,
    builtinsNames: Record<number, string> | null
): VectorLocations | null {
    if (scriptIds === null || scriptOffsets === null || scriptIds.length !== scriptOffsets.length) {
        return null;
    }

    const samples = new Uint32Array(scriptOffsets.length);
    // PERF: Sites grow from a size bounded by the allocation count, so short vectors allocate little
    const sites = new LocationSites(Math.min(scriptOffsets.length, 1 << 12));

    // Sites are owned by script ids
    sites.sitesOf(scriptIds, scriptOffsets, contextInfo, samples);

    const vmStateCallFrames = buildContextVmStateDict(
        dictionary,
        vmStateNames ?? emptyDict
    );
    const builtinsCallFrames = buildContextBuiltinDict(
        dictionary,
        builtinsNames ?? emptyDict
    );

    // The tree starts with the root (the root location, its own parent) and the node of the unknown location
    const nodeParent = [0, 0];
    const nodeLocations = [1, 0];
    const locationNodes = new Map([
        [1, 0],
        [0, 1]
    ]);
    const contextNodes = new Map<number, Map<number, number>>();

    const addNode = (parent: number, locationIndex: number) => {
        nodeParent.push(parent);
        nodeLocations.push(locationIndex);

        return nodeLocations.length - 1;
    };

    const locationNode = (locationIndex: number) => {
        let node = locationNodes.get(locationIndex);

        if (node === undefined) {
            node = addNode(0, locationIndex);
            locationNodes.set(locationIndex, node);
        }

        return node;
    };

    const contextNode = (parent: number, contextInfoValue: number) => {
        let nodeByParent = contextNodes.get(contextInfoValue);

        if (nodeByParent === undefined) {
            nodeByParent = new Map();
            contextNodes.set(contextInfoValue, nodeByParent);
        }

        let node = nodeByParent.get(parent);

        if (node === undefined) {
            const callFrame = resolveCallFrameFromContextInfo(
                dictionary,
                contextInfoValue,
                vmStateCallFrames,
                builtinsCallFrames
            );

            node = addNode(parent, dictionary.resolveLocationIndex(callFrame));
            nodeByParent.set(parent, node);
        }

        return node;
    };

    // Sites are resolved owner by owner in ascending script offsets, the order in which dictionary resolves
    // locations of a script; sites of the same offset differ in context info and share the offset's location
    const order = sites.ownerOffsetOrder();
    const ownerOffsets = new Int32Array(sites.count);
    const siteNodes = new Int32Array(sites.count);
    let ownerStart = 0;

    while (ownerStart < order.length) {
        const owner = sites.owners[order[ownerStart]];
        const script = scriptFromScriptId(owner, null, scriptsMap);
        let ownerEnd = ownerStart + 1;
        let offsetCount = 1;

        ownerOffsets[0] = sites.offsets[order[ownerStart]];

        while (ownerEnd < order.length && sites.owners[order[ownerEnd]] === owner) {
            const scriptOffset = sites.offsets[order[ownerEnd]];

            if (ownerOffsets[offsetCount - 1] !== scriptOffset) {
                ownerOffsets[offsetCount++] = scriptOffset;
            }

            ownerEnd++;
        }

        const locationIndices = script !== null
            ? dictionary.resolveScriptOffsetLocationIndices(script, ownerOffsets.subarray(0, offsetCount))
            : null;
        let offsetIndex = 0;

        for (let i = ownerStart; i < ownerEnd; i++) {
            const site = order[i];
            const contextInfoValue = sites.contexts[site];
            // Without a script and context info, the site is at the unknown location
            let node = 1;

            if (locationIndices !== null) {
                // The sites ascend in script offsets as the offsets of the locations do
                while (ownerOffsets[offsetIndex] !== sites.offsets[site]) {
                    offsetIndex++;
                }

                node = locationNode(locationIndices[offsetIndex]);

                if (contextInfoValue !== 0) {
                    node = contextNode(node, contextInfoValue);
                }
            } else if (contextInfoValue !== 0) {
                const callFrame = resolveCallFrameFromContextInfo(
                    dictionary,
                    contextInfoValue,
                    vmStateCallFrames,
                    builtinsCallFrames
                );

                node = locationNode(dictionary.resolveLocationIndex(callFrame));
            }

            siteNodes[site] = node;
        }

        ownerStart = ownerEnd;
    }

    return {
        parent: new Uint32Array(nodeParent),
        nodes: new Uint32Array(nodeLocations),
        sourceIdToNode: siteNodes,
        dictionary: dictionary.locations,
        samples
    };
}

// Sites of locations: script offsets of owners (call frames, call tree nodes or script ids) with context info,
// numbered in the order they are found. The table of sites is a compute buffer: elements find their sites
// in chunks staged into the buffer, by WASM or JavaScript, and the table grows between chunks.
class LocationSites {
    count = 0;
    #buffer: SitesBufferMap;
    #api: ComputeApi;

    constructor(size: number) {
        this.#buffer = createSitesBuffer(capacity(size));
        this.#api = createSitesApi(this.#buffer);
    }

    get owners() {
        return this.#buffer.siteOwners;
    }

    get offsets() {
        return this.#buffer.siteOffsets;
    }

    get contexts() {
        return this.#buffer.siteContexts;
    }

    // Sites of the elements of owners, offsets and contexts (zero when absent); sites may be owners,
    // since a chunk of elements is staged before its sites are written
    sitesOf(
        owners: Int32Array | Uint32Array,
        offsets: Int32Array,
        contexts: Uint32Array | null,
        sites: Uint32Array
    ) {
        let start = 0;

        while (start < offsets.length) {
            const end = Math.min(offsets.length, start + this.#buffer.sites.length);
            const size = end - start;

            // The table grows to room for the chunk's sites, the chunk of a grown table is no smaller
            if (this.count + size > this.owners.length) {
                this.#grow(capacity(this.count + size));
            }

            const buffer = this.#buffer;

            buffer.owners.set(owners.subarray(start, end));
            buffer.offsets.set(offsets.subarray(start, end));

            if (contexts !== null) {
                buffer.contexts.set(contexts.subarray(start, end));
            } else {
                buffer.contexts.fill(0);
            }

            this.count = this.#api.findSites(buffer, size, this.count);
            sites.set(buffer.sites.subarray(0, size), start);
            start = end;
        }
    }

    // Sites in ascending offsets of each owner, the owners in the order of their first sites: a radix sort
    // of offsets by 16-bit digits followed by a stable sort by owner
    ownerOffsetOrder() {
        const keys = new Uint32Array(this.count);
        const ownerKeys = new Map<number, number>();

        for (let i = 0; i < this.count; i++) {
            keys[i] = this.offsets[i] & 0xffff;
        }

        const lowDigitOrder = countingSort(createUint32Progression(this.count), keys, 0x10000);

        // The sign bit of the high digit is flipped, so negative offsets come first
        for (let i = 0; i < this.count; i++) {
            keys[i] = (this.offsets[i] >>> 16) ^ 0x8000;
        }

        const offsetOrder = countingSort(lowDigitOrder, keys, 0x10000);

        for (let i = 0; i < this.count; i++) {
            let ownerKey = ownerKeys.get(this.owners[i]);

            if (ownerKey === undefined) {
                ownerKey = ownerKeys.size;
                ownerKeys.set(this.owners[i], ownerKey);
            }

            keys[i] = ownerKey;
        }

        return countingSort(offsetOrder, keys, ownerKeys.size);
    }

    #grow(size: number) {
        const buffer = createSitesBuffer(size);
        const slots = buffer.slots;
        const slotMask = slots.length - 1;

        buffer.siteOwners.set(this.owners.subarray(0, this.count));
        buffer.siteOffsets.set(this.offsets.subarray(0, this.count));
        buffer.siteContexts.set(this.contexts.subarray(0, this.count));

        for (let i = 0; i < this.count; i++) {
            let slot = hashSite(this.owners[i], this.offsets[i], this.contexts[i]) & slotMask;

            while (slots[slot] !== -1) {
                slot = (slot + 1) & slotMask;
            }

            slots[slot] = i;
        }

        this.#buffer = buffer;
        this.#api = createSitesApi(buffer);
    }
}

// PERF: WASM reads its own memory only, so chunks of elements are staged into the buffer: the buffer stays small
// for any number of elements, and V8 replaces the baseline code of a WASM function by optimized code between calls
// rather than during one, so chunks after the first run optimized code
const sitesChunkSize = 1 << 16;
const sitesJavaScriptApi = createJavaScriptApi();

// A buffer of a table for a capacity of sites, its slots stay at most half occupied
function createSitesBuffer(siteCapacity: number) {
    const chunkSize = Math.min(siteCapacity, sitesChunkSize);
    const slotCount = 2 * siteCapacity;
    const byteSize =
        4 * chunkSize +    // owners
        4 * chunkSize +    // offsets
        4 * chunkSize +    // contexts
        4 * chunkSize +    // sites
        4 * slotCount +    // slots
        4 * siteCapacity + // siteOwners
        4 * siteCapacity + // siteOffsets
        4 * siteCapacity;  // siteContexts
    const memory = USE_WASM
        ? new WebAssembly.Memory({ initial: Math.ceil(byteSize / 0x10000) })
        : new Uint8Array(byteSize);
    const slotsOffset = 16 * chunkSize;
    const sitesOffset = slotsOffset + 4 * slotCount;
    const bufferMap: SitesBufferMap = {
        memory,
        owners: new Int32Array(memory.buffer, 0, chunkSize),
        offsets: new Int32Array(memory.buffer, 4 * chunkSize, chunkSize),
        contexts: new Uint32Array(memory.buffer, 8 * chunkSize, chunkSize),
        sites: new Uint32Array(memory.buffer, 12 * chunkSize, chunkSize),
        slots: new Int32Array(memory.buffer, slotsOffset, slotCount).fill(-1),
        siteOwners: new Int32Array(memory.buffer, sitesOffset, siteCapacity),
        siteOffsets: new Int32Array(memory.buffer, sitesOffset + 4 * siteCapacity, siteCapacity),
        siteContexts: new Uint32Array(memory.buffer, sitesOffset + 8 * siteCapacity, siteCapacity)
    };

    return bufferMap;
}

function createSitesApi(buffer: SitesBufferMap) {
    return buffer.memory instanceof WebAssembly.Memory
        ? createWasmApi(buffer.memory)
        : sitesJavaScriptApi;
}

// Indices in a stable order of their keys, the keys are below the key count
function countingSort(indices: Uint32Array, keys: Uint32Array, keyCount: number) {
    const keyStarts = new Uint32Array(keyCount + 1);
    const sorted = new Uint32Array(indices.length);

    for (let i = 0; i < indices.length; i++) {
        keyStarts[keys[indices[i]] + 1]++;
    }

    for (let i = 0; i < keyCount; i++) {
        keyStarts[i + 1] += keyStarts[i];
    }

    for (let i = 0; i < indices.length; i++) {
        const index = indices[i];

        sorted[keyStarts[keys[index]]++] = index;
    }

    return sorted;
}
