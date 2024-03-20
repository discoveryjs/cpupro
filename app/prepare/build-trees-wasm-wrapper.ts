/* eslint-env browser */
import buildTreesWasmSourceBase64 from './build-trees.wasm';
import { USE_WASM } from './const';

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

const base64alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64map = new Uint8Array(256);
const pageSize = 64 * 1024;

for (let i = 0; i < base64alphabet.length; i++) {
    base64map[base64alphabet.charCodeAt(i)] = i;
}

export function decodeBase64(input: string) {
    let inputSize = input.length;

    // ignore trailing "=" (padding)
    while (inputSize > 0 && input[inputSize - 1] === '=') {
        inputSize--;
    }

    const output = new Uint8Array(3 * Math.ceil(inputSize / 4));
    let enc1 = 0;
    let enc2 = 0;
    let enc3 = 0;
    let enc4 = 0;

    // decode
    for (let i = 0, j = 0; i < inputSize;) {
        enc1 = base64map[input.charCodeAt(i++) & 0xff];
        enc2 = base64map[input.charCodeAt(i++) & 0xff];
        enc3 = base64map[input.charCodeAt(i++) & 0xff];
        enc4 = base64map[input.charCodeAt(i++) & 0xff];

        output[j++] = (enc1 << 2) | (enc2 >> 4);
        output[j++] = (enc2 << 4) | (enc3 >> 2);
        output[j++] = (enc3 << 6) | enc4;
    }

    return output.subarray(0,
        // output size:
        // (length / 4) * 3 +
        ((inputSize >> 2) * 3) +
        // (length % 4) * 6 / 8
        (((inputSize % 4) * 6) >> 3)
    );
}

function createWasmModule(source: string, imports = {}) {
    const sourceBytes = decodeBase64(source);
    const importObject = { imports };
    const module = new WebAssembly.Module(sourceBytes);

    return new WebAssembly.Instance(module, importObject);
}

export function createWasmApi(): Api {
    const memory = new WebAssembly.Memory({ initial: 16 });
    const inflateModule = createWasmModule(buildTreesWasmSourceBase64, { memory }) as BuildTreesWasmModuleInstance;
    const { makeFirstNextArrays } = inflateModule.exports;

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
                memory.grow(Math.ceil((memoryNeeded - memory.buffer.byteLength) / pageSize));
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
