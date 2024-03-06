import { CpuProNode, V8CpuProfileNode } from './types.js';

// As of March 6th, 2024, V8 and JavaScriptCore do not seem to optimize for `new Uint32Array(array)` construction,
// showing no notable performance difference in SpiderMonkey.
// For large arrays, manually creating a Uint32Array and populating it element by element outperforms
// the direct constructor usage; benchmarking on a 1.5 million element number array yielded 25ms for direct
// construction vs. 3ms for manual population on a Mac M1 using V8.
export function convertToUint32Array(source: number[]) {
    const result = new Uint32Array(source.length);

    for (let i = 0; i < result.length; i++) {
        result[i] = source[i];
    }

    return result;
}

// Fastest way to find max id
export function findMaxId(nodes: V8CpuProfileNode[]) {
    let maxId = nodes[nodes.length - 1].id;

    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id > maxId) {
            maxId = nodes[i].id;
        }
    }

    return maxId;
}

export function remapId(node: CpuProNode, index: number) {
    node.id = index + 1;
}
