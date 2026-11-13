import {
    createComputeBuffer,
    wasmBacked,
    type WasmExports
} from '../computations/compute-wasm.js';
import { CONTEXT_KIND_BUILTIN, CONTEXT_KIND_VM_STATE, contextInfoKind } from '../preprocessing/locations.js';
import attributesWasm from './memline-attributes.compute.wasm';

// PERF: WASM reads its own memory only, so chunks of allocations are staged into the buffer: the buffer stays small
// for any number of allocations, and V8 replaces the baseline code of a WASM function by optimized code between calls
// rather than during one, so chunks after the first run optimized code
const attributeChunkSize = 1 << 16;
// Context info values a table of kinds covers at most: values of builtins are well below, a value beyond the table
// takes its kind by itself
const maxContextKindsLength = 1 << 16;

// Dictionary indices of codes through a table of the indices of codes, 0 for a code beyond the table
export function allocationDictIndices(codes: Uint32Array, table: Uint32Array, values: Uint8Array | Uint32Array) {
    // Values are the last vector, which leaves room for 4-byte writes of 1-byte values
    const buffer = createComputeBuffer({
        codes: [Uint32Array, attributeChunkSize],
        table: [Uint32Array, table.length + 1],
        values: [values instanceof Uint8Array ? Uint8Array : Uint32Array, attributeChunkSize]
    });
    const api = attributesApiOf(buffer);

    buffer.table.set(table);

    for (let start = 0; start < codes.length; start += attributeChunkSize) {
        const end = Math.min(codes.length, start + attributeChunkSize);

        buffer.codes.set(codes.subarray(start, end));
        api.dictIndices(buffer, end - start);
        values.set(buffer.values.subarray(0, end - start), start);
    }

    return values;
}

// Code types of allocations by the kinds of their context info (see contextInfoKind): a builtin takes the builtin
// type, a VM state the other type, JS its own code type. Kinds are taken once per value of context info into a table,
// which grows when a chunk has a value beyond it
export function allocationCodeTypes(
    codeTypes: Uint32Array,
    contextInfo: Uint32Array,
    builtinType: number,
    otherType: number
) {
    const values = new Uint8Array(codeTypes.length);
    let kinds = new Uint8Array(0);
    let buffer = createCodeTypesBuffer(kinds);
    let api = attributesApiOf(buffer);
    let start = 0;

    while (start < codeTypes.length) {
        const end = Math.min(codeTypes.length, start + attributeChunkSize);
        const size = end - start;
        let done = 0;

        buffer.codeTypes.set(codeTypes.subarray(start, end));
        buffer.contextInfo.set(contextInfo.subarray(start, end));
        done = api.contextCodeTypes(buffer, done, size, builtinType, otherType);

        while (done < size) {
            const info = buffer.contextInfo[done];

            if (info < maxContextKindsLength) {
                kinds = growContextKinds(kinds, info);
                buffer = createCodeTypesBuffer(kinds);
                api = attributesApiOf(buffer);
                break;
            }

            buffer.values[done] = codeTypeOfKind(
                contextInfoKind(info),
                buffer.codeTypes[done],
                builtinType,
                otherType
            );
            done = api.contextCodeTypes(buffer, done + 1, size, builtinType, otherType);
        }

        // A chunk stopped by a value beyond the table of kinds is staged again into the buffer of the grown table
        if (done === size) {
            values.set(buffer.values.subarray(0, size), start);
            start = end;
        }
    }

    return values;
}

// Kinds of context info values up to a value, the table grown to a power of two for a few growths
function growContextKinds(kinds: Uint8Array, info: number) {
    const grown = new Uint8Array(2 ** Math.ceil(Math.log2(info + 1)));

    grown.set(kinds);

    for (let i = kinds.length; i < grown.length; i++) {
        grown[i] = contextInfoKind(i);
    }

    return grown;
}

// A code type by the kind of context info
function codeTypeOfKind(kind: number, codeType: number, builtinType: number, otherType: number) {
    if (kind === CONTEXT_KIND_VM_STATE) {
        return otherType;
    }

    if (kind === CONTEXT_KIND_BUILTIN) {
        return builtinType;
    }

    return codeType;
}

function createCodeTypesBuffer(kinds: Uint8Array) {
    const buffer = createComputeBuffer({
        codeTypes: [Uint32Array, attributeChunkSize],
        contextInfo: [Uint32Array, attributeChunkSize],
        kinds: [Uint8Array, kinds.length],
        values: [Uint8Array, attributeChunkSize]
    });

    buffer.kinds.set(kinds);

    return buffer;
}

type DictIndicesBuffer = {
    codes: Uint32Array;
    table: Uint32Array;
    values: Uint8Array | Uint32Array;
};
type CodeTypesBuffer = ReturnType<typeof createCodeTypesBuffer>;
type AttributesApi = typeof attributesJavaScriptApi;

// The passes of memline-attributes.compute.wat over the first size staged allocations
const attributesJavaScriptApi = {
    dictIndices,
    contextCodeTypes
};

function dictIndices(buffer: DictIndicesBuffer, size: number) {
    const { codes, table, values } = buffer;
    const tableLength = table.length - 1;

    for (let i = 0; i < size; i++) {
        values[i] = table[Math.min(codes[i], tableLength)];
    }
}

// Values from start until a context info beyond the table of kinds; returns where it stopped, size when none is beyond
function contextCodeTypes(buffer: CodeTypesBuffer, start: number, size: number, builtinType: number, otherType: number) {
    const { codeTypes, contextInfo, kinds, values } = buffer;

    for (let i = start; i < size; i++) {
        if (contextInfo[i] >= kinds.length) {
            return i;
        }

        values[i] = codeTypeOfKind(kinds[contextInfo[i]], codeTypes[i], builtinType, otherType);
    }

    return size;
}

const attributesApiOf = wasmBacked(attributesWasm, attributesJavaScriptApi, bindAttributesWasm);

function bindAttributesWasm(wasm: WasmExports<'dictIndices' | 'contextCodeTypes'>): AttributesApi {
    return {
        dictIndices(buffer, size) {
            wasm.dictIndices(
                size,
                buffer.codes.byteOffset,
                buffer.table.byteOffset,
                buffer.table.length - 1,
                buffer.values.byteOffset,
                buffer.values.BYTES_PER_ELEMENT
            );
        },
        contextCodeTypes(buffer, start, size, builtinType, otherType) {
            return start + wasm.contextCodeTypes(
                size - start,
                buffer.codeTypes.byteOffset + start * 4,
                buffer.contextInfo.byteOffset + start * 4,
                buffer.kinds.byteOffset,
                buffer.kinds.length,
                builtinType,
                otherType,
                buffer.values.byteOffset + start
            );
        }
    };
}
