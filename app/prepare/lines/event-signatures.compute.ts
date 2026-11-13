import {
    createComputeBuffer,
    elementMask,
    wasmBacked,
    type VectorConstructor,
    type WasmExports
} from '../computations/compute-wasm.js';
import signaturesWasm from './event-signatures.compute.wasm';

export type ColumnValues = Uint8Array | Uint16Array | Uint32Array;
export type EventIds = Uint16Array | Uint32Array;
// Values of a column per event, or per sample when samples give the sample of every event; values of a column
// given per sample are u32
export type CombinedColumn = {
    values: ColumnValues;
    samples: Uint32Array | null;
    size: number;
};

// PERF: WASM reads its own memory only, so chunks of events are staged into the buffer: the buffer stays small
// for any number of events, and V8 replaces the baseline code of a WASM function by optimized code between calls
// rather than during one, so chunks after the first run optimized code
const combineChunkSize = 1 << 16;
// Columns a pass combines at most: the cost of a pass is about the same for fewer columns
export const maxEventColumns = 3;
export const maxSampleColumns = 2;

// A pass over the events combining their ids of sourceCount combinations of earlier columns, sourceIds or zeros when
// null, with the values of up to three columns given per event or two given per sample: combinations are numbered
// in the order of their first events, their ids are written to ids and their first events returned. Ids of two bytes
// are widened to four when they outgrow them, the widened vector is returned
export function combineColumnPass<T extends EventIds>(
    sourceIds: ColumnValues | null,
    sourceCount: number,
    ids: T,
    columns: CombinedColumn[]
) {
    const tableLength = sourceCount * columnsSize(columns);
    const buffer = columns[0].samples !== null
        ? createSampleColumnsBuffer(sourceIds, tableLength, columns)
        : createEventColumnsBuffer(sourceIds, tableLength, columns);
    const api = combineApiOf(buffer);
    // Staged vectors of the columns and their pass over a chunk: missing columns of a pass of fewer columns come
    // first and stay zeros
    const staged = 'first' in buffer
        ? [buffer.first, buffer.second, buffer.third].slice(maxEventColumns - columns.length)
        : [buffer.leftSamples, buffer.rightSamples].slice(maxSampleColumns - columns.length);
    const combineChunk = (chunkIds: EventIds, size: number, count: number) => 'first' in buffer
        ? api.combineEventColumns(buffer, chunkIds, size, count)
        : api.combineSampleColumns(buffer, chunkIds, size, count);
    const firstEvents: number[] = [];
    let passIds: T | Uint32Array = ids;
    let count = 0;
    let start = 0;

    while (start < passIds.length) {
        const end = Math.min(passIds.length, start + combineChunkSize);
        const size = end - start;

        if (sourceIds !== null) {
            buffer.sourceIds.set(sourceIds.subarray(start, end));
        }

        for (let i = 0; i < columns.length; i++) {
            staged[i].set((columns[i].samples ?? columns[i].values).subarray(start, end));
        }

        const next = combineChunk(idsChunk(buffer, passIds), size, count);

        // The chunk is combined again into widened ids: its combinations are in the table now, so it adds none
        if (next > 0x10000 && passIds instanceof Uint16Array) {
            passIds = new Uint32Array(passIds);
            combineChunk(idsChunk(buffer, passIds), size, count);
        }

        for (let i = 0; i < next - count; i++) {
            firstEvents.push(start + buffer.firstEvents[i]);
        }

        passIds.set(idsChunk(buffer, passIds).subarray(0, size), start);
        count = next;
        start = end;
    }

    return {
        ids: passIds,
        firstEvents
    };
}

// Number of combinations of the values of columns
function columnsSize(columns: CombinedColumn[]) {
    let size = 1;

    for (let i = 0; i < columns.length; i++) {
        size *= columns[i].size;
    }

    return size;
}

// Columns of a pass of an arity, missing ones (null) before them
function padColumns(columns: CombinedColumn[], arity: number) {
    const padded: (CombinedColumn | null)[] = [];

    for (let i = columns.length; i < arity; i++) {
        padded.push(null);
    }

    return padded.concat(columns);
}

// Element type of a staged vector, bytes of zeros for a missing one
function elementType(values: ColumnValues | null) {
    return (values?.constructor ?? Uint8Array) as VectorConstructor<ColumnValues>;
}

// Ids of a chunk in the element type of the vector of ids
function idsChunk(buffer: CombineBuffer, ids: EventIds): EventIds {
    return ids instanceof Uint16Array
        ? new Uint16Array(buffer.ids.buffer, buffer.ids.byteOffset, combineChunkSize)
        : buffer.ids;
}

// A buffer of a chunk of events and the table of a pass: source ids and columns are staged in the element types
// of their vectors, missing ones are zeros (as bytes). Ids are u32 to hold a chunk of either width, which leaves room
// for 4-byte writes of 2-byte ids. The table holds the id of every combination, its entries missing
function createEventColumnsBuffer(sourceIds: ColumnValues | null, tableLength: number, columns: CombinedColumn[]) {
    const [first, second, third] = padColumns(columns, maxEventColumns) as [
        CombinedColumn | null,
        CombinedColumn | null,
        CombinedColumn
    ];
    const buffer = createComputeBuffer({
        table: [Int32Array, tableLength],
        sourceIds: [elementType(sourceIds), combineChunkSize],
        first: [elementType(first?.values ?? null), combineChunkSize],
        second: [elementType(second?.values ?? null), combineChunkSize],
        third: [elementType(third.values), combineChunkSize],
        ids: [Uint32Array, combineChunkSize],
        firstEvents: [Uint32Array, combineChunkSize]
    });

    buffer.table.fill(-1);

    return {
        ...buffer,
        secondSize: second?.size ?? 1,
        thirdSize: third.size,
        valuesSize: columnsSize(columns)
    };
}

// A buffer of a chunk of events and the table of a pass over columns given per sample: samples are staged, keys
// of the samples are copied once. A missing column has samples of zeros and a key of zero
function createSampleColumnsBuffer(sourceIds: ColumnValues | null, tableLength: number, columns: CombinedColumn[]) {
    const [left, right] = padColumns(columns, maxSampleColumns) as [CombinedColumn | null, CombinedColumn];
    const buffer = createComputeBuffer({
        table: [Int32Array, tableLength],
        sourceIds: [elementType(sourceIds), combineChunkSize],
        leftSamples: [Uint32Array, combineChunkSize],
        leftKeys: [Uint32Array, left?.values.length ?? 1],
        rightSamples: [Uint32Array, combineChunkSize],
        rightKeys: [Uint32Array, right.values.length],
        ids: [Uint32Array, combineChunkSize],
        firstEvents: [Uint32Array, combineChunkSize]
    });

    buffer.table.fill(-1);
    buffer.rightKeys.set(right.values);

    if (left !== null) {
        buffer.leftKeys.set(left.values);
    }

    return {
        ...buffer,
        rightSize: right.size,
        valuesSize: columnsSize(columns)
    };
}

type EventColumnsBuffer = ReturnType<typeof createEventColumnsBuffer>;
type SampleColumnsBuffer = ReturnType<typeof createSampleColumnsBuffer>;
type CombineBuffer = EventColumnsBuffer | SampleColumnsBuffer;
type CombineApi = typeof combineJavaScriptApi;

// The passes of event-signatures.compute.wat over the first size staged events; return the count after them
const combineJavaScriptApi = {
    combineEventColumns,
    combineSampleColumns
};

function combineEventColumns(buffer: EventColumnsBuffer, ids: EventIds, size: number, count: number) {
    const {
        table,
        sourceIds,
        first,
        second,
        third,
        firstEvents,
        secondSize,
        thirdSize,
        valuesSize
    } = buffer;
    const firstId = count;

    for (let i = 0; i < size; i++) {
        const entry = sourceIds[i] * valuesSize + (first[i] * secondSize + second[i]) * thirdSize + third[i];
        let id = table[entry];

        if (id === -1) {
            id = count++;
            table[entry] = id;
            firstEvents[id - firstId] = i;
        }

        ids[i] = id;
    }

    return count;
}

function combineSampleColumns(buffer: SampleColumnsBuffer, ids: EventIds, size: number, count: number) {
    const {
        table,
        sourceIds,
        leftSamples,
        leftKeys,
        rightSamples,
        rightKeys,
        firstEvents,
        rightSize,
        valuesSize
    } = buffer;
    const firstId = count;

    for (let i = 0; i < size; i++) {
        const entry = sourceIds[i] * valuesSize + leftKeys[leftSamples[i]] * rightSize + rightKeys[rightSamples[i]];
        let id = table[entry];

        if (id === -1) {
            id = count++;
            table[entry] = id;
            firstEvents[id - firstId] = i;
        }

        ids[i] = id;
    }

    return count;
}

const combineApiOf = wasmBacked(signaturesWasm, combineJavaScriptApi, bindCombineWasm);

function bindCombineWasm(wasm: WasmExports<'combineEventColumns' | 'combineSampleColumns'>): CombineApi {
    return {
        combineEventColumns(buffer, ids, size, count) {
            return wasm.combineEventColumns(
                size,
                buffer.sourceIds.byteOffset,
                buffer.sourceIds.BYTES_PER_ELEMENT,
                elementMask(buffer.sourceIds),
                buffer.first.byteOffset,
                buffer.first.BYTES_PER_ELEMENT,
                elementMask(buffer.first),
                buffer.second.byteOffset,
                buffer.second.BYTES_PER_ELEMENT,
                elementMask(buffer.second),
                buffer.third.byteOffset,
                buffer.third.BYTES_PER_ELEMENT,
                elementMask(buffer.third),
                buffer.secondSize,
                buffer.thirdSize,
                buffer.valuesSize,
                buffer.table.byteOffset,
                ids.byteOffset,
                ids.BYTES_PER_ELEMENT,
                buffer.firstEvents.byteOffset,
                count
            );
        },
        combineSampleColumns(buffer, ids, size, count) {
            return wasm.combineSampleColumns(
                size,
                buffer.sourceIds.byteOffset,
                buffer.sourceIds.BYTES_PER_ELEMENT,
                elementMask(buffer.sourceIds),
                buffer.leftSamples.byteOffset,
                buffer.leftKeys.byteOffset,
                buffer.rightSamples.byteOffset,
                buffer.rightKeys.byteOffset,
                buffer.rightSize,
                buffer.valuesSize,
                buffer.table.byteOffset,
                ids.byteOffset,
                ids.BYTES_PER_ELEMENT,
                buffer.firstEvents.byteOffset,
                count
            );
        }
    };
}
