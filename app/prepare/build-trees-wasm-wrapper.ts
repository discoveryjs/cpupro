/* eslint-env browser */
import { USE_WASM } from './const';
import { bytesToWasmMemoryPages, decodeBase64 } from './utils';
import buildTreesWasmSourceBase64 from './build-trees.wasm';

type BuildTreesWasmModuleInstance = {
    exports: {
        makeFirstNextArrays(
            parent: number,
            subtreeSizeOffset: number,
            firstChild: number,
            nextSibling: number,
            length: number
        ): void;
    }
}
type Api = {
    makeFirstNextArrays(parent: Uint32Array, subtreeSize: Uint32Array): {
        firstChild: Uint32Array,
        nextSibling: Uint32Array
    };
};

let wasmApi: Api | null = null;
let javaScriptApi: Api | null = null;
let api: Api | null = null;

function createWasmModule(source: string, imports = {}) {
    const sourceBytes = decodeBase64(source);
    const importObject = { imports };
    const module = new WebAssembly.Module(sourceBytes);

    return new WebAssembly.Instance(module, importObject);
}

export function createWasmApi(): Api {
    const memory = new WebAssembly.Memory({ initial: 16 });
    const wasmModule = createWasmModule(buildTreesWasmSourceBase64, { memory }) as BuildTreesWasmModuleInstance;
    const { makeFirstNextArrays } = wasmModule.exports;

    return {
        makeFirstNextArrays(parent, subtreeSize) {
            const arraySize = parent.byteLength;
            const memoryNeeded = 4 * arraySize;
            const parentOffset = 0;
            const subtreeSizeOffset = arraySize;
            const firstChildOffset = 2 * arraySize;
            const nextSiblingOffset = 3 * arraySize;

            // increase wasm module's memory if needed
            if (memoryNeeded > memory.buffer.byteLength) {
                memory.grow(bytesToWasmMemoryPages(memoryNeeded - memory.buffer.byteLength));
            }

            const mem = new Uint8Array(memory.buffer);
            mem.set(new Uint8Array(parent.buffer), parentOffset);
            mem.set(new Uint8Array(subtreeSize.buffer), subtreeSizeOffset);
            mem.fill(0, firstChildOffset, firstChildOffset + 2 * arraySize);

            makeFirstNextArrays(
                parentOffset,
                subtreeSizeOffset,
                firstChildOffset,
                nextSiblingOffset,
                parent.length
            );

            // return arrays as non-copy since these arrays are used as temporary
            return {
                firstChild: new Uint32Array(memory.buffer, firstChildOffset, arraySize >> 2),
                nextSibling: new Uint32Array(memory.buffer, nextSiblingOffset, arraySize >> 2)
            };
        }
    };
}

export function createJavaScriptApi(): Api {
    return {
        makeFirstNextArrays(parent, subtreeSize) {
            const firstChild = new Uint32Array(parent.length);
            const nextSibling = new Uint32Array(parent.length);

            for (let i = 0; i < parent.length; i++) {
                const size = subtreeSize[i];
                const nextSinlingCandidate = i + size + 1;

                // has children
                if (size > 0) {
                    firstChild[i] = i + 1;
                }

                // next has the same parent
                if (parent[i] === parent[nextSinlingCandidate]) {
                    nextSibling[i] = nextSinlingCandidate;
                }
            }

            return {
                firstChild,
                nextSibling
            };
        }
    };
}

export function getDefaultWasmApi() {
    if (wasmApi === null) {
        wasmApi = createWasmApi();
    }

    return wasmApi;
}

export function getDefaultJavaScriptApi() {
    if (javaScriptApi === null) {
        javaScriptApi = createJavaScriptApi();
    }

    return javaScriptApi;
}

export function getDefaultApi(): Api {
    if (api === null) {
        api = USE_WASM
            ? getDefaultWasmApi()
            : getDefaultJavaScriptApi();
    }

    return api;
}

function getDefaultFunction(name: keyof Api) {
    return getDefaultApi()[name];
}

export const makeFirstNextArrays = getDefaultFunction('makeFirstNextArrays');
