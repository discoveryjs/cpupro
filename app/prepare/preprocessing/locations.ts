import { scriptFromScriptId } from './scripts.js';
import { capacity, createUint32Progression, grow } from '../misc/utils.js';
import type { Dictionary } from '../dictionary.js';
import type { TreeSource } from '../computations/build-trees.js';
import type {
    AllocationContextInfoVector,
    AllocationScriptIdVector,
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
    // A location per site of a call frame at a script offset
    const callFrameSites = new LocationSites(treeNodeCount);
    const callFrameSiteLocations: number[] = [];
    // A node per site of a sampled node at a script offset, the nodes follow the call tree nodes
    const sampleSites = new LocationSites(Math.min(samples.length, 1 << 12));
    const sampleLocations: number[] = [];
    const sampleParents: number[] = [];
    const treeLocations = new Uint32Array(treeNodeCount);

    const locationOf = (callFrameIndex: number, scriptOffset: number) => {
        const count = callFrameSites.count;
        const site = callFrameSites.siteOf(callFrameIndex, scriptOffset, 0);

        if (site === count) {
            callFrameSiteLocations.push(dict.resolveLocationIndex(
                callFrames[callFrameIndex],
                null,
                scriptOffset
            ));
        }

        return callFrameSiteLocations[site];
    };

    // The location of a node is the script offset of its call in the parent's call frame
    for (let i = 0; i < treeNodeCount; i++) {
        treeLocations[i] = locationOf(nodeCallFrames[nodeParent[i]], nodeScriptOffsets[i]);
    }

    // A sample becomes a sample of the node of its script offset in its node's call frame;
    // a sample of the previous node and offset takes its sample without a lookup
    let previousNode = -1;
    let previousScriptOffset = 0;
    let sample = 0;

    for (let i = 0; i < samples.length; i++) {
        const node = samples[i];
        const scriptOffset = sampledScriptOffsets[i];

        if (node !== previousNode || scriptOffset !== previousScriptOffset) {
            const count = sampleSites.count;

            sample = sampleSites.siteOf(node, scriptOffset, 0);

            if (sample === count) {
                sampleLocations.push(locationOf(nodeCallFrames[node] || 0, scriptOffset));
                sampleParents.push(node);
            }

            previousNode = node;
            previousScriptOffset = scriptOffset;
        }

        samples[i] = sample;
    }

    const nodeCount = treeNodeCount + sampleLocations.length;
    const nodes = new Uint32Array(nodeCount);
    const parent = new Uint32Array(nodeCount);
    const sourceIdToNode = new Int32Array(sampleLocations.length);

    nodes.set(treeLocations);
    nodes.set(sampleLocations, treeNodeCount);
    parent.set(nodeParent);
    parent.set(sampleParents, treeNodeCount);

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
    scriptIds: AllocationScriptIdVector | null,
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
    // NaN differs from any script id, so the first allocation looks its site up
    let previousScriptId: number | string = NaN;
    let previousScriptOffset = 0;
    let previousContextInfo = 0;
    let numericScriptId = 0;
    let sample = 0;

    for (let i = 0; i < scriptOffsets.length; i++) {
        const scriptId = scriptIds[i];
        const scriptOffset = scriptOffsets[i];
        const contextInfoValue = contextInfo !== null ? contextInfo[i] : 0;

        if (scriptOffset !== previousScriptOffset ||
            contextInfoValue !== previousContextInfo ||
            scriptId !== previousScriptId) {
            if (scriptId !== previousScriptId) {
                // Sites are owned by script ids in the numeric domain of the profile's scripts,
                // some formats give script ids as strings
                numericScriptId = typeof scriptId === 'number'
                    ? scriptId
                    : scriptsMap.normalizeScriptId(scriptId);
            }

            sample = sites.siteOf(numericScriptId, scriptOffset, contextInfoValue);
            previousScriptId = scriptId;
            previousScriptOffset = scriptOffset;
            previousContextInfo = contextInfoValue;
        }

        samples[i] = sample;
    }

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
// numbered in the order they are added. A hash table finds the site of an owner, an offset and context info.
class LocationSites {
    owners: Int32Array;
    offsets: Int32Array;
    contexts: Uint32Array;
    count = 0;
    #slots: Int32Array;

    constructor(size: number) {
        this.owners = new Int32Array(capacity(size));
        this.offsets = new Int32Array(this.owners.length);
        this.contexts = new Uint32Array(this.owners.length);
        this.#slots = new Int32Array(2 * this.owners.length).fill(-1);
    }

    // The site of an owner's script offset with context info; a missing site is added as the next one
    siteOf(owner: number, offset: number, context: number) {
        const slots = this.#slots;
        const slotMask = slots.length - 1;
        const homeSlot = hashSite(owner, offset, context) & slotMask;
        let slot = homeSlot;
        let site = slots[slot];

        while (site !== -1) {
            if (this.offsets[site] === offset &&
                this.contexts[site] === context &&
                this.owners[site] === owner) {
                // PERF: A found site takes its home slot, so sites met again are found at the first probe.
                // The site displaced from the home slot takes the found one's slot, which follows the home slot
                // in the same run of occupied slots, so a probe from its own home slot still reaches it
                if (slot !== homeSlot) {
                    slots[slot] = slots[homeSlot];
                    slots[homeSlot] = site;
                }

                return site;
            }

            slot = (slot + 1) & slotMask;
            site = slots[slot];
        }

        site = this.count++;

        if (site === this.owners.length) {
            this.owners = grow(this.owners);
            this.offsets = grow(this.offsets);
            this.contexts = grow(this.contexts);
        }

        this.owners[site] = owner;
        this.offsets[site] = offset;
        this.contexts[site] = context;
        slots[slot] = site;

        if (2 * this.count > slots.length) {
            this.#rehash();
        }

        return site;
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

    #rehash() {
        const slots = new Int32Array(2 * this.#slots.length).fill(-1);
        const slotMask = slots.length - 1;

        for (let i = 0; i < this.count; i++) {
            let slot = hashSite(this.owners[i], this.offsets[i], this.contexts[i]) & slotMask;

            while (slots[slot] !== -1) {
                slot = (slot + 1) & slotMask;
            }

            slots[slot] = i;
        }

        this.#slots = slots;
    }
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

function hashSite(owner: number, offset: number, context: number) {
    const key = owner ^ Math.imul(offset, 0x85ebca6b) ^ Math.imul(context, 0xc2b2ae35);
    const hash = Math.imul(key, 0x9e3779b1);

    return (hash ^ (hash >>> 16)) >>> 0;
}
