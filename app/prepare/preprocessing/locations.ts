import { scriptFromScriptId } from './scripts.js';
import type { Dictionary } from '../dictionary.js';
import type { TreeSource } from '../computations/build-trees.js';
import type { CpuProCallFrame, CpuProLocation, IProfileScriptsMap } from '../types.js';
import { LocationSites } from './locations.compute.js';

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

// Context info of an allocation (V8's EncodeContextInfo) holds a VM state in bits 0-3 and a builtin in bits 4-31
// as its id + 1, 0 without a builtin. The fields are independent, a compiler may allocate under a builtin;
// the names of VM states and builtins are keyed by the fields
export function contextInfoVmState(contextInfo: number) {
    return contextInfo & 0x0f;
}

export function contextInfoBuiltin(contextInfo: number) {
    return contextInfo >>> 4;
}

// Kinds of what allocates in a context, numbers for the readers of an allocation each
export const CONTEXT_KIND_JS = 0;
export const CONTEXT_KIND_VM_STATE = 1;
export const CONTEXT_KIND_BUILTIN = 2;

// What allocates in a context: a VM state other than JS (0) takes precedence over a builtin
export function contextInfoKind(contextInfo: number) {
    if (contextInfoVmState(contextInfo) !== 0) {
        return CONTEXT_KIND_VM_STATE;
    }

    if (contextInfoBuiltin(contextInfo) !== 0) {
        return CONTEXT_KIND_BUILTIN;
    }

    return CONTEXT_KIND_JS;
}

function resolveContextVmStateCallFrame(
    dictionary: Dictionary,
    vmState: number,
    vmStateCallFrames: (CpuProCallFrame | null)[]
): CpuProCallFrame {
    let callFrame = vmStateCallFrames[vmState];

    if (!callFrame) {
        // TODO: add a diagnostic here to indicate that an unknown VM state code was encountered
        callFrame = resolveVmStateCallFrame(dictionary, `unknown-vm-state[${vmState}]`);
        callFrame.kind = 'vm-state';
        vmStateCallFrames[vmState] = callFrame;
    }

    return callFrame;
}

function resolveContextBuiltinCallFrame(
    dictionary: Dictionary,
    builtin: number,
    builtinsCallFrames: (CpuProCallFrame | null)[]
): CpuProCallFrame {
    let callFrame = builtinsCallFrames[builtin];

    if (!callFrame) {
        // TODO: add a diagnostic here to indicate that an unknown builtin code was encountered
        callFrame = resolveBuiltinCallFrame(dictionary, `unknown-builtin[${builtin}]`);
        builtinsCallFrames[builtin] = callFrame;
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
    scriptIds: Uint32Array | null,
    scriptOffsets: Int32Array | null,
    contextInfo: Uint32Array | null,
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
    const childNodes = new Map<number, Map<number, number>>(); // location → parent → node
    const contextNodes = new Map<number, Map<number, number>>(); // context info → parent → node

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

    // A child of the root is the node of its location
    const childNode = (parent: number, locationIndex: number) => {
        if (parent === 0) {
            return locationNode(locationIndex);
        }

        let nodeByParent = childNodes.get(locationIndex);

        if (nodeByParent === undefined) {
            nodeByParent = new Map();
            childNodes.set(locationIndex, nodeByParent);
        }

        let node = nodeByParent.get(parent);

        if (node === undefined) {
            node = addNode(parent, locationIndex);
            nodeByParent.set(parent, node);
        }

        return node;
    };

    // Context info under a node is a chain of its builtin and then its VM state other than JS, so neither is lost
    // when a VM state allocates under a builtin; contexts of a builtin under the same node share its node
    const contextNode = (parent: number, contextInfoValue: number) => {
        let nodeByParent = contextNodes.get(contextInfoValue);

        if (nodeByParent === undefined) {
            nodeByParent = new Map();
            contextNodes.set(contextInfoValue, nodeByParent);
        }

        let node = nodeByParent.get(parent);

        if (node === undefined) {
            const builtin = contextInfoBuiltin(contextInfoValue);
            const vmState = contextInfoVmState(contextInfoValue);

            node = parent;

            if (builtin !== 0) {
                const callFrame = resolveContextBuiltinCallFrame(dictionary, builtin, builtinsCallFrames);

                node = childNode(node, dictionary.resolveLocationIndex(callFrame));
            }

            if (vmState !== 0) {
                const callFrame = resolveContextVmStateCallFrame(dictionary, vmState, vmStateCallFrames);

                node = childNode(node, dictionary.resolveLocationIndex(callFrame));
            }

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
                node = contextNode(0, contextInfoValue);
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
