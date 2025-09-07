import type { V8CpuProfile, V8CpuProfileNode, V8CpuProfileScript } from '../types.js';
import { ALLOCATION_SPACES, ALLOCATION_TIMESPANS, ALLOCATION_INSTANCE_TYPES } from './memprofile-types.js';

type SizeSample = {
    size: number;
    nodeId: number;
    ordinal: number;
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

function isArrayOfIntegers(value: unknown): value is number[] {
    if (!Array.isArray(value) || ArrayBuffer.isView(value)) {
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
        if (!isArrayOfIntegers(maybe.samples)) {
            return false;
        }

        if (!isArrayOfIntegers(maybe.timeDeltas)) {
            return false;
        }
    }

    return true;
}

export function normalizeCpuProfile(data: V8CpuProfile) {
    return {
        ...data,
        trace_ids: data.trace_ids || {},
        lines: Array.isArray(data.lines) && data.lines.length > 0 ? data.lines : undefined,
        columns: Array.isArray(data.columns) && data.columns.length > 0 ? data.columns : undefined
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
        return samples.map(sample => sample[property] as number);
    }
}

function extractRemapVectorIfExists(samples: SizeSample[], vectorName: keyof SizeSample, nameMap: Record<number, string>, useId = false) {
    let vector = extractVectorIfExists(samples, vectorName);
    let names: string[] = [];

    if (vector !== undefined) {
        const map = new Map([...new Set(vector)].map((type, idx) => [type, idx]));

        vector = vector.map(origType => map.get(origType) || 0);
        names = [...map.keys()].map(k => useId || !Object.hasOwn(nameMap, k)
            ? `(${k}) ${nameMap[k] || 'unknown'}`
            : nameMap[k] || 'unknown'
        );
    }

    return { vector, names };
}

export function unwrapSamplesIfNeeded(profile: V8CpuProfile & {
    samples: number[] | SizeSample[];
    scripts?: V8CpuProfileScript[];
}): V8CpuProfile {
    if (isArrayOfIntegers(profile.samples)) {
        return profile;
    }

    let source = profile.samples as SizeSample[];

    // allocation samples can be in a random order, sort it by ordinal
    // Note: used slice() to avoid mutation of an input array
    source = source.slice().sort((a, b) => a.ordinal - b.ordinal);

    const { vector: typeVector, names: typeNames } = extractRemapVectorIfExists(source, 'type', ALLOCATION_INSTANCE_TYPES, true);
    const { vector: spaceVector, names: spaceNames } = extractRemapVectorIfExists(source, 'space', ALLOCATION_SPACES);
    const { vector: gcVector, names: gcNames } = extractRemapVectorIfExists(source, 'gc', ALLOCATION_TIMESPANS);

    return {
        ...profile,
        _type: 'memory',
        _memoryGc: gcVector,
        _memoryGcNames: gcNames,
        _memoryType: typeVector,
        _memoryTypeNames: typeNames,
        _memorySpace: spaceVector,
        _memorySpaceNames: spaceNames,
        _samplePositions: extractVectorIfExists(source, 'pos'),
        _scripts: profile._scripts || profile.scripts || undefined,
        samples: source.map(sample => sample.nodeId),
        timeDeltas: source.map(sample => sample.size)
    };
}
