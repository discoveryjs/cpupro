/* eslint-env browser */
import { base64 } from '@discoveryjs/discovery/lib/core/utils/index-script.js';
import { USE_WASM } from '../const.js';

// Computations backed by WASM. An owner X keeps its low-level computations apart: X.compute.wat is the module
// (compiled by scripts/wat-compile.mjs), X.compute.ts lays out the compute buffer, holds the JavaScript twin
// of the module's exports and binds the exports to the vectors of the buffer by their byte offsets, and gives X
// an api over the buffer, the module's when the buffer's memory is WASM memory and the twin's otherwise

export type ComputeMemory = WebAssembly.Memory | Uint8Array;
export type ComputeVector = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array;
export type VectorConstructor<T extends ComputeVector> = {
    new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
    BYTES_PER_ELEMENT: number;
};
// Vectors of a buffer in their order in its memory: element types and lengths
export type BufferLayout = Record<string, [VectorConstructor<ComputeVector>, number]>;
export type ComputeBuffer<L extends BufferLayout> = { memory: ComputeMemory } & {
    [K in keyof L]: L[K] extends [VectorConstructor<infer T>, number] ? T : never;
};
// Exports of a module by their names; the module lists their parameters
export type WasmExports<Name extends string> = Record<Name, (...args: number[]) => number>;

// Memory of a compute buffer: WASM memory, or bytes for the JavaScript twins
export function createComputeMemory(byteSize: number): ComputeMemory {
    return USE_WASM
        ? new WebAssembly.Memory({ initial: Math.ceil(byteSize / 0x10000) })
        : new Uint8Array(byteSize);
}

// A buffer of vectors in one memory, a vector starts at a multiple of its element size. The memory keeps room
// after the last vector for a read of 4 bytes at any element (see elementMask)
export function createComputeBuffer<L extends BufferLayout>(layout: L) {
    const names = Object.keys(layout);
    const offsets: number[] = [];
    let byteSize = 0;

    for (let i = 0; i < names.length; i++) {
        const [Type, length] = layout[names[i]];
        const offset = Math.ceil(byteSize / Type.BYTES_PER_ELEMENT) * Type.BYTES_PER_ELEMENT;

        offsets.push(offset);
        byteSize = offset + Type.BYTES_PER_ELEMENT * length;
    }

    const memory = createComputeMemory(byteSize + 3);
    const buffer: Record<string, ComputeMemory | ComputeVector> = { memory };

    for (let i = 0; i < names.length; i++) {
        const [Type, length] = layout[names[i]];

        buffer[names[i]] = new Type(memory.buffer, offsets[i], length);
    }

    return buffer as ComputeBuffer<L>;
}

// Mask of the bytes of an element of a vector of 1, 2 or 4 byte unsigned integers. WASM reads an element of any
// width as 4 bytes at its byte offset and masks out the bytes after it, so a vector is staged in its own element type
// PERF: Classes of records staged as Uint32 by a converting copy cost about 12% more of the grouping in Chrome
export function elementMask(vector: Uint8Array | Uint16Array | Uint32Array) {
    return 2 ** (8 * vector.BYTES_PER_ELEMENT) - 1;
}

// The api of a computation over a compute buffer: the module's exports bound by bindWasm over WASM memory,
// the JavaScript twin over bytes. The module is compiled once, on the first WASM memory
export function wasmBacked<Api, Name extends string>(
    source: string, // the module in base64, as bundled
    javaScriptApi: Api,
    bindWasm: (wasm: WasmExports<Name>) => Api
) {
    let module: WebAssembly.Module | null = null;

    return function apiOf(buffer: { memory: ComputeMemory }): Api {
        const memory = buffer.memory;

        if (memory instanceof Uint8Array) {
            return javaScriptApi;
        }

        if (module === null) {
            module = new WebAssembly.Module(base64.decodeBytes(source));
        }

        const instance = new WebAssembly.Instance(module, { imports: { memory } });

        return bindWasm(instance.exports as WasmExports<Name>);
    };
}
