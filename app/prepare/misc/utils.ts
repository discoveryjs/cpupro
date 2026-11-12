import type { PackageProviderEndpoint, PackageRegistry, V8CpuProfileNode } from '../types.js';

export function isInt32Vector(value: unknown): value is number[] | Int32Array {
    return Array.isArray(value) || value instanceof Int32Array;
}

export function isUint32Vector(value: unknown): value is number[] | Uint32Array {
    return Array.isArray(value) || value instanceof Uint32Array;
}

export function isFloat64Vector(value: unknown): value is number[] | Float64Array {
    return Array.isArray(value) || value instanceof Float64Array;
}

export function isNumberVector(value: unknown): value is number[] | Uint32Array | Float64Array {
    return isUint32Vector(value) || value instanceof Float64Array;
}

// Fraction digits for values in a unit of a given size to tell apart a resolution, at least one as by default
export function fractionDigits(resolution: number, unit: number) {
    return Math.max(1, Math.ceil(Math.log10(unit / resolution)));
}

export function asUint32Array(source: number[] | Uint32Array): Uint32Array {
    return Array.isArray(source) ? new Uint32Array(source) : source;
}

export function asInt32Array(source: number[] | Int32Array): Int32Array {
    return Array.isArray(source) ? new Int32Array(source) : source;
}

export function sum(array: number[] | Int32Array | Uint32Array | Float64Array) {
    let sum = 0;

    for (let i = 0; i < array.length; i++) {
        sum += array[i];
    }

    return sum;
}

export function min(array: number[] | Int32Array | Uint32Array | Float64Array) {
    let min = array[0];

    for (let i = 1; i < array.length; i++) {
        if (array[i] < min) {
            min = array[i];
        }
    }

    return min;
}

export function max(array: number[] | Int32Array | Uint32Array | Float64Array) {
    let max = array[0];

    for (let i = 1; i < array.length; i++) {
        if (array[i] > max) {
            max = array[i];
        }
    }

    return max;
}

export function convertToUint32Array(source: number[] | Int32Array | Uint32Array | Float64Array, extraLength: number = 0) {
    const result = new Uint32Array(source.length + extraLength);

    result.set(source);

    return result;
}
export function convertToInt32Array(source: number[] | Int32Array | Uint32Array, extraLength: number = 0) {
    const result = new Int32Array(source.length + extraLength);

    result.set(source);

    return result;
}

export function createUint32Progression(length: number) {
    const result = new Uint32Array(length);

    for (let i = 0; i < length; i++) {
        result[i] = i;
    }

    return result;
}
export function createInt32Progression(length: number) {
    const result = new Int32Array(length);

    for (let i = 0; i < length; i++) {
        result[i] = i;
    }

    return result;
}

// Power of two size of a table or a growing typed array, at least 16
export function powerOfTwoCapacity(size: number) {
    return 2 ** Math.ceil(Math.log2(Math.max(16, size)));
}

// A typed array of twice the length with the array's elements
export function growTypedArray<T extends Int32Array | Uint32Array | Float64Array>(array: T): T {
    const grown = new (array.constructor as new (length: number) => T)(array.length * 2);

    grown.set(array);

    return grown;
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
