import { getNumericArrayOrder } from './utils.js';
import { ALLOCATION_INSTANCE_TYPES } from './memprofile-types.js';
import { isInt32Vector, isNumberVector, isUint32Vector } from '../misc/utils.js';
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

// Allocation rows of a combined profile, aligned by their IDs
type CombinedAllocationRows = {
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

// A profile whose samples are not yet samples of node IDs: a combined profile wraps CPU samples into `cpuProfile`
// and gives allocation data apart, a profile of size samples gives allocations as samples
type WrappedSamplesProfile = V8CpuProfile & {
    samples: SampleIdVector | SizeSample[];
    sizes?: number[];
    scripts?: V8CpuProfileScript[];
    allocationSampleIds?: AllocationIdVector;
    allocationSamples?: CombinedAllocationRows;
    cpuProfile?: {
        samples: SampleIdVector;
        timeDeltas?: TimeDeltaVector;
        nodes: V8CpuProfileNode[];
    };
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
    if (!isNumberVector(value) && !isInt32Vector(value)) {
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

        if (!isArrayOfIntegers(maybe.timeDeltas)) {
            return false;
        }
    }

    return true;
}

// Nodes of a call tree given as a head with nested children, as a list of nodes with IDs of children
function linearCallTree(node: V8CpuProfileNode, nodes: V8CpuProfileNode[] = []) {
    const children = node.children as (V8CpuProfileNode[] | undefined);

    if (Array.isArray(children)) {
        nodes.push({
            ...node,
            children: children.map(child => child.id)
        });

        for (let i = 0; i < children.length; i++) {
            linearCallTree(children[i], nodes);
        }
    }

    return nodes;
}

function unrollHeadToNodes(profile: V8CpuProfile & { head?: V8CpuProfileNode }) {
    const head = profile.head;

    if (!head) {
        return profile;
    }

    return {
        ...profile,
        nodes: linearCallTree(head)
    };
}

// Allocation data of a combined profile: the last allocation ID of every CPU sample and allocation rows in the order
// of their IDs
function extractCombinedAllocationData(
    profile: WrappedSamplesProfile,
    diagnose: Diagnose
): V8CpuProfileCpuproExtensions | null {
    const sampleAllocationIds = profile.allocationSampleIds;
    const rows = profile.allocationSamples;

    if (!isNumberVector(sampleAllocationIds)) {
        return null;
    }

    const allocationData: V8CpuProfileCpuproExtensions = {
        _cpuproAllocationMapping: sampleAllocationIds
    };

    if (!rows || !isNumberVector(rows.ids) || !isUint32Vector(rows.sizes)) {
        return allocationData;
    }

    const idsOrder = getNumericArrayOrder(rows.ids);

    if (idsOrder === 'unordered') {
        diagnose('warn', 'Ignoring allocation data with unsorted IDs');
        return allocationData;
    }

    return {
        ...allocationData,
        _cpuproAllocationIds: rows.ids,
        _cpuproAllocationIdsOrder: idsOrder,
        _cpuproAllocationSizes: rows.sizes,
        _cpuproAllocationScriptIds: isInt32Vector(rows.scriptIds)
            ? rows.scriptIds
            : undefined,
        _cpuproAllocationLocations: isInt32Vector(rows.positions)
            ? rows.positions
            : undefined,
        _cpuproAllocationGc: isUint32Vector(rows.gc)
            ? rows.gc
            : undefined,
        _cpuproAllocationTypes: isUint32Vector(rows.types)
            ? rows.types
            : undefined,
        _cpuproAllocationTypeNames: rows.typesDict,
        _cpuproAllocationSpaces: isUint32Vector(rows.spaces)
            ? rows.spaces
            : undefined,
        _cpuproAllocationSpaceNames: rows.spacesDict
    };
}

// A vector of a field of size samples, when they have the field
function sizeSampleVector(samples: SizeSample[], field: keyof SizeSample) {
    if (samples.length === 0 || !(field in samples[0])) {
        return undefined;
    }

    return Array.from(samples, sample => sample[field] as number);
}

// Samples of node IDs: CPU samples of a combined profile come with its allocation data, samples of sizes become
// allocations of their nodes
function unwrapSamples(profile: WrappedSamplesProfile, diagnose: Diagnose): V8CpuProfile {
    const allocationData = extractCombinedAllocationData(profile, diagnose);

    if (allocationData !== null) {
        const cpuProfile = profile.cpuProfile || profile;

        return {
            ...profile,
            nodes: cpuProfile.nodes || profile.nodes,
            samples: cpuProfile.samples,
            timeDeltas: cpuProfile.timeDeltas || profile.timeDeltas,
            ...allocationData
        };
    }

    if (isArrayOfIntegers(profile.samples) && !profile.sizes) {
        return profile;
    }

    // Samples of sizes are a format of early allocation experiments, no longer current and kept as reference only.
    // They come in any order, so they are sorted by ordinals on a copy
    const source = (profile.samples as SizeSample[])
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal);
    const typeVector = sizeSampleVector(source, 'type');
    const scriptIdVector = sizeSampleVector(source, 'scriptId');
    // const { vector: spaceVector, names: spaceNames } = extractRemapVectorIfExists(source, 'space', ALLOCATION_SPACES);
    const gcVector = sizeSampleVector(source, 'gc');
    const locationVector = sizeSampleVector(source, 'pos');

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

// The common form of a CPU profile, whatever form its source gives: a list of nodes with children or a parent, as
// the source gives them, samples of node IDs with allocation data apart, trace IDs as an object, lines and columns
// of samples together, a line and a column per sample, or neither. Each step returns a new object when it changes
// anything, so the input is not changed
export function normalizeCpuProfile(data: V8CpuProfile, diagnose: Diagnose = diagnoseToConsole): V8CpuProfile {
    let profile = unrollHeadToNodes(data);

    profile = unwrapSamples(profile, diagnose);

    const traceIds = isObject(profile.trace_ids) && !Array.isArray(profile.trace_ids)
        ? profile.trace_ids
        : {};
    const hasLineColumns = isInt32Vector(profile.lines) &&
        isInt32Vector(profile.columns) &&
        profile.lines.length > 0 &&
        profile.lines.length === profile.samples.length &&
        profile.columns.length === profile.samples.length;

    return {
        ...profile,
        trace_ids: traceIds,
        lines: hasLineColumns
            ? profile.lines
            : undefined,
        columns: hasLineColumns
            ? profile.columns
            : undefined
    };
}
