import { PackageProviderEndpoint, PackageRegistry, V8CpuProfileNode } from '../types.js';

export function sum(array: Uint32Array | number[]) {
    let sum = 0;

    for (let i = 0; i < array.length; i++) {
        sum += array[i];
    }

    return sum;
}

export function min(array: Uint32Array | number[]) {
    let min = array[0];

    for (let i = 1; i < array.length; i++) {
        if (array[i] < min) {
            min = array[i];
        }
    }

    return min;
}

export function convertToUint32Array(source: number[], extraLength: number = 0) {
    const result = new Uint32Array(source.length + extraLength);

    result.set(source);

    return result;
}
export function convertToInt32Array(source: number[], extraLength: number = 0) {
    const result = new Int32Array(source.length + extraLength);

    result.set(source);

    return result;
}

// Convert bytes into WebAssembly memory pages
const WASM_PAGE_SIZE = 64 * 1024;
export function bytesToWasmMemoryPages(bytes: number) {
    return Math.ceil(bytes / WASM_PAGE_SIZE);
}

// Fastest way to find max id
export function findMaxId(nodes: V8CpuProfileNode<unknown>[]) {
    let maxId = nodes[nodes.length - 1].id;

    // Usually, maxId equals the length of the nodes array (id in range [1 .. nodes.length]).
    // Search for maxId only if this condition is not met, indicating that nodes are shuffled or have gaps
    if (maxId !== nodes.length) {
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].id > maxId) {
                maxId = nodes[i].id;
            }
        }
    }

    return maxId;
}

export const createRegistryRx = (function() {
    const pkg = '(?<pkg>(?:[^/]+/)?[^/]+?)';
    const atpkg = '(?<pkg>(?:@[^/]+/)?[^/]+?)';
    const version = '(?:@(?<version>[^/]+))?';
    const path = '(?:\/(?<path>.+))?';
    const replacements = {
        specifier: atpkg + version + path,
        pkg,
        atpkg,
        version,
        '/version': '(?:/(?<version>[^/]+))?',
        path
    };
    const replacementsRx = new RegExp(`\\[(${Object.keys(replacements).join('|')})\\]`, 'g');

    return function createRegistryRx(pattern: string) {
        return new RegExp(`^/${pattern.replace(
            replacementsRx,
            (_, name) => replacements[name]
        )}$`, 'd');
    };
}());

export function packageRegistryEndpoints(
    ...endpoints: Array<PackageRegistry | { registry: PackageRegistry, pattern?: string }>
): PackageProviderEndpoint[] {
    return endpoints.map(enpoint => (
        typeof enpoint === 'string'
            ? {
                registry: enpoint,
                pattern: createRegistryRx('[specifier]')
            } : {
                registry: enpoint.registry,
                pattern: createRegistryRx(enpoint.pattern || '[specifier]')
            })
    );
}
