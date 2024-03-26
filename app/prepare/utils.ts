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

// Convert bytes into WebAssembly memory pages
const WASM_PAGE_SIZE = 64 * 1024;
export function bytesToWasmMemoryPages(bytes: number) {
    return Math.ceil(bytes / WASM_PAGE_SIZE);
}

// Base64 decode
const base64alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64map = new Uint8Array(256);

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

export function createMarkTime() {
    let markTimeTimestamp = Date.now();
    let markTimeStep = null;

    return (name: string) => {
        const newTimestamp = Date.now();

        if (markTimeStep !== null) {
            console.info('>', markTimeStep, newTimestamp - markTimeTimestamp);
        }

        markTimeStep = name;
        markTimeTimestamp = newTimestamp;
    };
}
