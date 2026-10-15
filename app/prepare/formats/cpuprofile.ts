import { getNumericArrayOrder } from './utils.js';
import { ALLOCATION_INSTANCE_TYPES } from './memprofile-types.js';
import { isFloat64Vector, isInt32Vector, isNumberVector, isUint32Vector } from '../misc/utils.js';
import { type Diagnose, diagnoseToConsole } from '../diagnostics.js';
import type {
    AllocationIdVector,
    SampleIdVector,
    TimeDeltaVector,
    V8CpuProfile,
    V8CpuProfileNode,
    V8CpuProfileScript,
    V8CpuProfileCpuproExtensions
} from '../types.js';

type SizeSample = {
    size: number;
    nodeId: number;
    ordinal: number;
    scriptId?: number | string;
    gc?: number;
    pos?: number;
    type?: number;
    space?: number;
};

function isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null;
}

function isNode(value: unknown): value is V8CpuProfileNode {
    const maybeNode = value as Partial<V8CpuProfileNode>;

    if (!isObject(maybeNode)) {
        return false;
    }

    if (typeof maybeNode.id !== 'number') {
        return false;
    }

    if (!isObject(maybeNode.callFrame)) {
        return false;
    }

    const scriptId = maybeNode.callFrame.scriptId;

    // allow scriptId as a string since some profiles contain scriptId in the form ":number" or a URL
    if (typeof scriptId !== 'string' && (typeof scriptId !== 'number' || !Number.isInteger(scriptId))) {
        return false;
    }

    return true;
}

function isArrayOfIntegers(value: unknown): value is SampleIdVector | TimeDeltaVector {
    if (!isNumberVector(value)) {
        return false;
    }

    return value.length > 0
        ? Number.isInteger(value[0]) && (value.length === 1 || Number.isInteger(value[1]))
        : true;
}

function isArrayLike(value: unknown, check: (value: unknown) => boolean): boolean {
    if (!Array.isArray(value)) {
        return false;
    }

    return value.length > 0
        ? check(value[0]) && (value.length === 1 || check(value[1]))
        : true;
}

function isSizeSamples(value: unknown): value is SizeSample[] {
    return isArrayLike(value, (item) =>
        typeof item === 'object' &&
        item !== null &&
        'size' in item &&
        typeof item.size === 'number'
    );
}

// TODO: split into isCPUProfile & isAllocationProfile
export function isCPUProfile(data: unknown): data is V8CpuProfile {
    const maybe = data as Partial<V8CpuProfile>;

    if (!isObject(maybe)) {
        return false;
    }

    if (!isArrayLike(maybe.nodes, isNode) && !('head' in maybe && isNode(maybe.head))) {
        return false;
    }

    if (!isSizeSamples(maybe.samples)) {
        if (!isUint32Vector(maybe.samples) ||
            !isArrayOfIntegers(maybe.samples)
        ) {
            return false;
        }

        if ((!isFloat64Vector(maybe.timeDeltas) && !isUint32Vector(maybe.timeDeltas)) ||
            !isArrayOfIntegers(maybe.timeDeltas)
        ) {
            return false;
        }
    }

    return true;
}

export function normalizeCpuProfile(data: V8CpuProfile) {
    return {
        ...data,
        trace_ids: data.trace_ids || {},
        lines: isInt32Vector(data.lines) && data.lines.length > 0 ? data.lines : undefined,
        columns: isInt32Vector(data.columns) && data.columns.length > 0 ? data.columns : undefined
    };
}

// nodes may missing children field but have parent field, rebuild children arrays then;
// avoid updating children when nodes have parent and children fields
export function convertParentIntoChildrenIfNeeded(data: V8CpuProfile) {
    const nodes: (V8CpuProfileNode<unknown> & { parent?: number })[] = data.nodes;

    // no action when just one node or both first nodes has no parent (since only root node can has no parent)
    if (nodes.length < 2 || (typeof nodes[0].parent !== 'number' && typeof nodes[1].parent !== 'number')) {
        return;
    }

    // build map for nodes with no children only
    const nodeWithNoChildrenById = new Map();

    for (const node of data.nodes) {
        if (!Array.isArray(node.children) || node.children.length === 0) {
            nodeWithNoChildrenById.set(node.id, node);
        }
    }

    // rebuild children for nodes which missed it
    if (nodeWithNoChildrenById.size > 0) {
        for (const node of nodes) {
            if (typeof node.parent === 'number') {
                const parent = nodeWithNoChildrenById.get(node.parent);

                if (parent !== undefined) {
                    if (Array.isArray(parent.children)) {
                        parent.children.push(node.id);
                    } else {
                        parent.children = [node.id];
                    }
                }
            }
        }
    }
}

function linearCallTree(node: V8CpuProfileNode, nodes: V8CpuProfileNode[] = []) {
    const children = node.children as (V8CpuProfileNode[] | undefined);

    if (Array.isArray(children)) {
        nodes.push({
            ...node,
            children: children.map(child => child.id)
        });

        for (const child of children) {
            linearCallTree(child, nodes);
        }
    }

    return nodes;
}

export function unrollHeadToNodesIfNeeded(profile: V8CpuProfile & { head?: V8CpuProfileNode }) {
    const head = profile.head;

    if (!head) {
        return profile;
    }

    return {
        ...profile,
        nodes: linearCallTree(head)
    };
}

function extractVectorIfExists(samples: SizeSample[], property: keyof SizeSample) {
    if (samples.length > 0 && property in samples[0]) {
        return Array.from(samples, sample => sample[property] as number);
    }
}

/**
 * Extract allocation data from combined CPU+memory profile.
 * Combined profiles have:
 * - cpuProfile: standard CPU profile with samples/timeDeltas
 * - allocationSampleIds: maps CPU sample index -> last allocation ID in that sample's time range
 * - allocationSamples: allocation data (ids, sizes, gc, types, etc.)
 */
function extractCombinedAllocationData(data: {
    allocationSampleIds?: unknown;
    allocationSamples?: {
        ids?: unknown;
        sizes?: unknown;
        scriptIds?: unknown;
        positions?: unknown;
        gc?: unknown;
        types?: unknown;
        typesDict?: Record<string, string>;
        spaces?: unknown;
        spacesDict?: Record<string, string>;
    };
}, diagnose: Diagnose): V8CpuProfileCpuproExtensions | null {
    const { allocationSampleIds, allocationSamples } = data;

    if (!isNumberVector(allocationSampleIds)) {
        return null;
    }

    const allocationData: V8CpuProfileCpuproExtensions = {
        _cpuproAllocationMapping: allocationSampleIds
    };

    if (!allocationSamples) {
        return allocationData;
    }

    const { ids, sizes, scriptIds, positions, gc, types, typesDict, spaces, spacesDict } = allocationSamples;

    if (!isNumberVector(ids) || !isUint32Vector(sizes)) {
        return allocationData;
    }

    const idsOrder = getNumericArrayOrder(ids);

    if (idsOrder === 'unordered') {
        diagnose('warn', 'Ignoring allocation data with unsorted IDs');
        return allocationData;
    }

    return {
        ...allocationData,
        _cpuproAllocationIds: ids,
        _cpuproAllocationIdsOrder: idsOrder,
        _cpuproAllocationSizes: sizes,
        _cpuproAllocationScriptIds: isInt32Vector(scriptIds) ? scriptIds : undefined,
        _cpuproAllocationLocations: isInt32Vector(positions) ? positions : undefined,
        _cpuproAllocationGc: isUint32Vector(gc) ? gc : undefined,
        _cpuproAllocationTypes: isUint32Vector(types) ? types : undefined,
        _cpuproAllocationTypeNames: typesDict,
        _cpuproAllocationSpaces: isUint32Vector(spaces) ? spaces : undefined,
        _cpuproAllocationSpaceNames: spacesDict
    };
}


export function unwrapSamplesIfNeeded(profile: V8CpuProfile & {
    samples: SampleIdVector | SizeSample[];
    sizes?: number[];
    scripts?: V8CpuProfileScript[];
    allocationSampleIds?: AllocationIdVector;
    allocationSamples?: {
        ids?: unknown;
        sizes?: unknown;
        scriptIds?: unknown;
        positions?: unknown;
        gc?: unknown;
        types?: unknown;
        typesDict?: Record<string, string>;
    };
    cpuProfile?: {
        samples: SampleIdVector;
        timeDeltas?: TimeDeltaVector;
        nodes: V8CpuProfileNode[];
    };
}, diagnose: Diagnose = diagnoseToConsole): V8CpuProfile {
    // Handle combined profile format (ProfileChunk with cpuProfile + allocationSamples)
    const combinedAllocationData = extractCombinedAllocationData(profile, diagnose);
    if (combinedAllocationData) {
        // Extract CPU profile data
        const cpuProfile = profile.cpuProfile || profile;
        const cpuSamples = cpuProfile.samples;
        const cpuTimeDeltas = cpuProfile.timeDeltas || profile.timeDeltas;

        return {
            ...profile,
            nodes: cpuProfile.nodes || profile.nodes,
            samples: cpuSamples,
            timeDeltas: cpuTimeDeltas,
            ...combinedAllocationData
        };
    }

    // Handle legacy allocation profile format (with sizes field)
    if (isArrayOfIntegers(profile.samples) && !profile.sizes) {
        return profile;
    }

    const samples = profile.samples as SizeSample[];
    let source = samples as SizeSample[];

    // allocation samples can be in any order, sort it by ordinal
    // Note: used slice() to avoid mutation of an input array
    source = source.slice().sort((a, b) => a.ordinal - b.ordinal);

    const typeVector = extractVectorIfExists(source, 'type');
    const scriptIdVector = extractVectorIfExists(source, 'scriptId');
    // const { vector: spaceVector, names: spaceNames } = extractRemapVectorIfExists(source, 'space', ALLOCATION_SPACES);
    const gcVector = extractVectorIfExists(source, 'gc');
    const locationVector = extractVectorIfExists(source, 'pos');

    // return {
    //     _cpuproAllocationMapping: allocationSampleIds,
    //     _cpuproAllocationIds: ids,
    //     _cpuproAllocationSizes: sizes,
    //     _cpuproAllocationGc: Array.isArray(gc) ? gc : undefined,
    //     _cpuproAllocationTypes: Array.isArray(types) ? types : undefined,
    //     _cpuproAllocationTypeNames: typesDict
    // };

    return {
        ...profile,
        _type: 'memory',
        _cpuproAllocationGc: gcVector,
        // _memoryGcNames: gcNames,
        _cpuproAllocationTypes: typeVector,
        _cpuproAllocationTypeNames: ALLOCATION_INSTANCE_TYPES,
        _cpuproAllocationScriptIds: scriptIdVector,
        // _memorySpace: spaceVector,
        // _memorySpaceNames: spaceNames,
        _cpuproAllocationLocations: locationVector,
        _scripts: profile._scripts || profile.scripts || undefined,
        samples: source.map(sample => sample.nodeId),
        _cpuproAllocationSizes: source.map(sample => sample.size)
    };
}
