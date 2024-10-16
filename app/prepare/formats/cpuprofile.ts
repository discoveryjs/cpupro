import type { V8CpuProfile, V8CpuProfileNode } from '../types.js';

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

    if (!isObject(maybeNode.callFrame) || !Number.isInteger(Number(maybeNode.callFrame.scriptId))) {
        return false;
    }

    return true;
}

function isArrayOfIntegers(value: unknown): boolean {
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

export function isCPUProfile(data: unknown): data is V8CpuProfile {
    const maybe = data as Partial<V8CpuProfile>;

    if (!isObject(maybe)) {
        return false;
    }

    if (!isArrayLike(maybe.nodes, isNode)) {
        return false;
    }

    if (!isArrayOfIntegers(maybe.samples)) {
        return false;
    }

    if (!isArrayOfIntegers(maybe.timeDeltas)) {
        return false;
    }

    return true;
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
