import assert from 'node:assert/strict';
import { afterEach, inject, test, vi } from 'vitest';
import createWabt from 'wabt';
import { createComputeBuffer, wasmBacked, type WasmExports } from './compute-wasm.js';

// A module storing a value at a byte offset of its memory, and its twin over a vector
const storeWat = `
(import "imports" "memory" (memory 0))
(func (export "store") (param $offset i32) (param $value i32)
  (i32.store (local.get $offset) (local.get $value))
)
`;
const storeJavaScriptApi = {
    store(vector: Uint32Array, value: number) {
        vector[0] = value;
    }
};

async function compileStoreModule() {
    const wabt = await createWabt();
    const module = wabt.parseWat('store.wat', storeWat);

    try {
        return Buffer.from(module.toBinary({}).buffer).toString('base64');
    } finally {
        module.destroy();
    }
}

function bindStoreWasm(wasm: WasmExports<'store'>): typeof storeJavaScriptApi {
    return {
        store(vector, value) {
            wasm.store(vector.byteOffset, value);
        }
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

test('lays out vectors of a description in order, aligned and without overlaps, in the memory of the buffer', () => {
    const buffer = createComputeBuffer({
        bytes: [Uint8Array, 3],
        totals: [Float64Array, 2],
        halves: [Uint16Array, 5],
        offsets: [Int32Array, 1],
        empty: [Uint32Array, 0],
        counts: [Uint32Array, 4]
    });
    const vectors = [buffer.bytes, buffer.totals, buffer.halves, buffer.offsets, buffer.empty, buffer.counts];
    const lengths = [3, 2, 5, 1, 0, 4];

    assert.equal(buffer.memory instanceof WebAssembly.Memory, inject('useWasm'));

    for (let i = 0; i < vectors.length; i++) {
        assert.equal(vectors[i].buffer, buffer.memory.buffer);
        assert.equal(vectors[i].length, lengths[i]);
        assert.equal(vectors[i].byteOffset % vectors[i].BYTES_PER_ELEMENT, 0);

        if (i > 0) {
            assert.ok(vectors[i].byteOffset >= vectors[i - 1].byteOffset + vectors[i - 1].byteLength);
        }
    }

    assert.notEqual(createComputeBuffer({ counts: [Uint32Array, 4] }).memory.buffer, buffer.memory.buffer);
});

test('compiles a module once and instantiates it over every WASM memory', async () => {
    const apiOf = wasmBacked(await compileStoreModule(), storeJavaScriptApi, bindStoreWasm);
    const compile = vi.spyOn(WebAssembly, 'Module');
    const first = { memory: new WebAssembly.Memory({ initial: 1 }) };
    const second = { memory: new WebAssembly.Memory({ initial: 1 }) };
    const firstVector = new Uint32Array(first.memory.buffer, 8, 1);
    const secondVector = new Uint32Array(second.memory.buffer, 8, 1);

    apiOf(first).store(firstVector, 1);
    apiOf(second).store(secondVector, 2);
    apiOf(first).store(firstVector, 3);

    assert.equal(compile.mock.calls.length, 1);
    assert.deepEqual([firstVector[0], secondVector[0]], [3, 2]);
});

test('gives the JavaScript twin over bytes without compiling the module', () => {
    const apiOf = wasmBacked('not a module', storeJavaScriptApi, bindStoreWasm);
    const compile = vi.spyOn(WebAssembly, 'Module');

    assert.equal(apiOf({ memory: new Uint8Array(8) }), storeJavaScriptApi);
    assert.equal(compile.mock.calls.length, 0);
});
