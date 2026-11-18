import { HeapSnapshotStringArray, HeapSnapshotStrings, type HeapSnapshotStringTable } from './heap-snapshot-strings.js';
import {
    createSliceBuffer,
    scanApiOf,
    SLICE_SIZE,
    STATE_COUNT,
    STATE_EXCEPTION_COUNT,
    STATE_OUT_OF_RANGE,
    STATE_SIZE,
    STATE_STRING_COUNT,
    type ScanApi,
    type SliceBuffer
} from './heap-snapshot.compute.js';

// A heap snapshot as V8 writes it (HeapSnapshotJSONSerializer): an object of sections. The meta describes the
// records of a section of numbers by their fields; fields and sections differ between V8 versions
export type V8HeapSnapshotMeta = {
    node_fields: string[];
    node_types: (string | string[])[];
    edge_fields: string[];
    edge_types: (string | string[])[];
    [fields: string]: (string | string[])[];
};
export type V8HeapSnapshot = {
    snapshot: {
        meta: V8HeapSnapshotMeta;
        node_count: number;
        edge_count: number;
        trace_function_count: number;
        extra_native_bytes?: number;
    };
    nodes: HeapSnapshotTable;
    edges: HeapSnapshotTable;
    strings: HeapSnapshotStrings | string[];
    // Tables of the other sections the meta describes (trace_function_infos, samples, locations, scopes, ...),
    // and the parsed JSON of the rest (trace_tree)
    [section: string]: unknown;
};
// A column per field of the records of a section. A field of an enumeration type takes a byte; a value out of
// u32 range makes its column Float64Array. A field of the "node" type holds the index of a node, V8 writes
// the offset of the node's fields in the nodes section
export type HeapSnapshotColumn = Uint8Array | Uint32Array | Float64Array;
export type HeapSnapshotTable = {
    length: number;
    columns: Record<string, HeapSnapshotColumn>;
};

// A heap snapshot of a session: the sections of a decoded snapshot, the decoded object isn't kept
export type UniformHeapSnapshot = {
    snapshot: V8HeapSnapshot['snapshot'];
    nodes: HeapSnapshotTable;
    edges: HeapSnapshotTable;
    strings: HeapSnapshotStringTable;
    sections: Record<string, unknown>; // the other sections, e.g. locations, samples, scopes, trace_tree
};

// The fields of a section in the meta
const sectionFields: Record<string, string> = {
    nodes: 'node_fields',
    edges: 'edge_fields',
    trace_function_infos: 'trace_function_info_fields',
    samples: 'sample_fields',
    locations: 'location_fields',
    scopes: 'scope_fields',
    scope_context_vars: 'scope_context_var_fields',
    scope_uses: 'scope_use_fields'
};

const textDecoder = new TextDecoder();

// A snapshot with its sections of numbers as columns: decoded by the heap-snapshot encoding, or written so
// (e.g. jsonxl with a TypedArray per field) and decoded with strings as an array. A snapshot of V8's layout,
// with arrays of numbers, isn't one
export function isHeapSnapshot(data: unknown): data is V8HeapSnapshot {
    const maybe = data as Partial<V8HeapSnapshot> | null;

    return (
        maybe?.snapshot?.meta !== undefined &&
        maybe.nodes?.columns !== undefined &&
        maybe.edges?.columns !== undefined
    );
}

export function extractFromHeapSnapshot(data: V8HeapSnapshot): UniformHeapSnapshot {
    const { snapshot, nodes, edges, strings, ...sections } = data;

    return {
        snapshot,
        nodes,
        edges,
        strings: Array.isArray(strings)
            ? new HeapSnapshotStringArray(strings)
            : strings,
        sections
    };
}

// Decoding of a stream of a heap snapshot (an encoding, see app/encodings.js)
export async function decode(iterator: AsyncIterable<Uint8Array>) {
    const parser = new HeapSnapshotParser();

    for await (const chunk of iterator) {
        parser.push(chunk);
    }

    return parser.finish();
}

// The snapshot is read section by section: the name of a section, then its value. Sections of numbers and the
// strings are scanned in slices (heap-snapshot.compute.ts); the snapshot's meta and other sections are JSON
class HeapSnapshotParser {
    #phase: 'property' | 'json' | 'numbers' | 'strings' | 'end' = 'property';
    #result: Record<string, unknown> = {};
    #meta: V8HeapSnapshotMeta | null = null;
    #slice: SliceBuffer = createSliceBuffer();
    #api = scanApiOf(this.#slice);
    #sliceState = new Uint32Array(STATE_SIZE); // the state before a slice, to scan it again

    // a section's name and the bytes read of it
    #name: string | null = null;
    #bytes: Uint8Array[] = [];
    #byteCount = 0;

    // JSON: depth of brackets, inside a string, after "\"
    #depth = 0;
    #inString = false;
    #escaped = false;

    #table: TableBuilder | null = null;
    #stringStarts: Uint32Array[] = [];

    push(chunk: Uint8Array) {
        let offset = 0;

        while (offset < chunk.length) {
            switch (this.#phase) {
                case 'property': offset = this.#readProperty(chunk, offset); break;
                case 'json': offset = this.#readJson(chunk, offset); break;
                case 'numbers': offset = this.#readNumbers(chunk, offset); break;
                case 'strings': offset = this.#readStrings(chunk, offset); break;
                case 'end': offset = chunk.length; break;
            }
        }
    }

    finish() {
        if (this.#phase !== 'end') {
            throw new Error('Heap snapshot is incomplete');
        }

        return this.#result as V8HeapSnapshot;
    }

    // A quoted name, then the start of its value after ":"; the brace of the snapshot has no name before it,
    // and its closing brace ends the snapshot
    #readProperty(chunk: Uint8Array, offset: number) {
        for (; offset < chunk.length; offset++) {
            const byte = chunk[offset];

            if (this.#inString) {
                if (byte === 34 /* " */) {
                    this.#inString = false;
                } else {
                    this.#name += String.fromCharCode(byte);
                }
            } else if (byte === 34 /* " */) {
                this.#name = '';
                this.#inString = true;
            } else if (this.#name !== null && (byte === 123 /* { */ || byte === 91 /* [ */)) {
                this.#startValue(byte);

                return offset + 1;
            } else if (byte === 125 /* } */) {
                this.#phase = 'end';

                return offset + 1;
            }
        }

        return offset;
    }

    // The meta comes first and describes the sections of numbers
    #startValue(byte: number) {
        const name = this.#name!;
        const fieldsKey = sectionFields[name];
        const fields = fieldsKey !== undefined
            ? this.#meta?.[fieldsKey] as string[] | undefined
            : undefined;

        if (byte === 91 /* [ */ && name === 'strings') {
            this.#phase = 'strings';
            this.#slice.state.fill(0);
        } else if (byte === 91 /* [ */ && fields !== undefined) {
            this.#phase = 'numbers';
            this.#slice.state.fill(0);
            this.#table = this.#createTable(name, fields);
            this.#slice.divisors.set(this.#table.divisors);
        } else {
            this.#phase = 'json';
            this.#depth = 1;
            this.#bytes.push(Uint8Array.of(byte));
        }
    }

    // Nodes and edges have their counts in the snapshot and types of their fields in the meta
    #createTable(name: string, fields: string[]) {
        const meta = this.#meta!;
        const snapshot = this.#result.snapshot as V8HeapSnapshot['snapshot'];
        const lengths: Record<string, number> = {
            nodes: snapshot.node_count,
            edges: snapshot.edge_count
        };
        const types: Record<string, (string | string[])[]> = {
            nodes: meta.node_types,
            edges: meta.edge_types
        };

        return new TableBuilder(fields, types[name] ?? null, lengths[name] ?? null, meta.node_fields.length);
    }

    // A JSON value up to the bracket closing its first one
    #readJson(chunk: Uint8Array, offset: number) {
        const start = offset;

        for (; offset < chunk.length; offset++) {
            const byte = chunk[offset];

            if (this.#inString) {
                if (this.#escaped) {
                    this.#escaped = false;
                } else if (byte === 92 /* \ */) {
                    this.#escaped = true;
                } else if (byte === 34 /* " */) {
                    this.#inString = false;
                }
            } else if (byte === 34 /* " */) {
                this.#inString = true;
            } else if (byte === 123 /* { */ || byte === 91 /* [ */) {
                this.#depth++;
            } else if ((byte === 125 /* } */ || byte === 93 /* ] */) && --this.#depth === 0) {
                this.#bytes.push(chunk.subarray(start, offset + 1));
                this.#finishJson();

                return offset + 1;
            }
        }

        this.#bytes.push(chunk.subarray(start));

        return offset;
    }

    #finishJson() {
        const name = this.#name!;
        const value = JSON.parse(textDecoder.decode(joinChunks(this.#bytes, Uint8Array)));

        this.#result[name] = value;
        this.#bytes = [];
        this.#name = null;
        this.#phase = 'property';

        if (name === 'snapshot') {
            this.#meta = value.meta;
        }
    }

    #readNumbers(chunk: Uint8Array, offset: number) {
        const slice = this.#slice;
        const size = Math.min(SLICE_SIZE, chunk.length - offset);

        slice.bytes.set(chunk.subarray(offset, offset + size));
        this.#sliceState.set(slice.state);

        let closed = this.#api.scanNumbers(slice, size);

        if (slice.state[STATE_OUT_OF_RANGE]) {
            slice.state.set(this.#sliceState);
            closed = this.#api.scanExceptions(slice, size);
        }

        const table = this.#table!;

        table.append(slice, this.#api, slice.state[STATE_COUNT], slice.state[STATE_EXCEPTION_COUNT]);

        if (closed === -1) {
            return offset + size;
        }

        this.#result[this.#name!] = table.finish(this.#name!);
        this.#table = null;
        this.#name = null;
        this.#phase = 'property';

        return offset + closed;
    }

    // The bytes of the section are kept with the offsets of its strings
    #readStrings(chunk: Uint8Array, offset: number) {
        const slice = this.#slice;
        const size = Math.min(SLICE_SIZE, chunk.length - offset);

        slice.bytes.set(chunk.subarray(offset, offset + size));

        const closed = this.#api.scanStrings(slice, size, this.#byteCount);
        const sectionSize = closed === -1
            ? size
            : closed - 1;

        this.#bytes.push(chunk.subarray(offset, offset + sectionSize));
        this.#byteCount += sectionSize;
        this.#stringStarts.push(slice.values.slice(0, slice.state[STATE_STRING_COUNT]));

        if (closed === -1) {
            return offset + size;
        }

        this.#result.strings = new HeapSnapshotStrings(
            joinChunks(this.#bytes, Uint8Array),
            joinChunks(this.#stringStarts, Uint32Array)
        );
        this.#bytes = [];
        this.#byteCount = 0;
        this.#stringStarts = [];
        this.#name = null;
        this.#phase = 'property';

        return offset + closed;
    }
}

// The columns of a section's records filled by the values of slices split by field. A section of an unknown length
// collects the values of each field in chunks joined when it's closed. A value out of u32 range makes its column
// Float64Array when the section is closed
class TableBuilder {
    fields: string[];
    length: number | null;
    divisors: Uint32Array; // a node field holds a node index, its value is the offset of the node's fields
    columns: (Uint8Array | Uint32Array)[];
    chunks: Uint32Array[][];
    exceptionRows: number[][];
    exceptionValues: number[][];
    valueCount = 0;

    constructor(
        fields: string[],
        types: (string | string[])[] | null,
        length: number | null,
        nodeFieldCount: number
    ) {
        this.fields = fields;
        this.length = length;
        this.divisors = new Uint32Array(fields.length);
        this.columns = [];
        this.chunks = [];
        this.exceptionRows = [];
        this.exceptionValues = [];

        for (let i = 0; i < fields.length; i++) {
            const type = types?.[i] ?? null;

            this.divisors[i] = type === 'node' ? nodeFieldCount : 1;
            this.chunks.push([]);
            this.exceptionRows.push([]);
            this.exceptionValues.push([]);

            if (length !== null) {
                this.columns.push(createColumn(length, type));
            }
        }
    }

    // The values of a field go to rows of its column from its first row in the slice
    append(slice: SliceBuffer, api: ScanApi, count: number, exceptionCount: number) {
        const fieldCount = this.fields.length;
        const firstField = this.valueCount % fieldCount;
        const firstRow = (this.valueCount - firstField) / fieldCount;
        let offset = 0;

        api.splitFields(slice, count, fieldCount, firstField);

        for (let i = 0; i < fieldCount; i++) {
            const first = (i + fieldCount - firstField) % fieldCount;
            const rows = Math.ceil(Math.max(count - first, 0) / fieldCount);
            const values = slice.fields.subarray(offset, offset + rows);
            const row = i < firstField
                ? firstRow + 1
                : firstRow;

            if (this.length === null) {
                this.chunks[i].push(values.slice());
            } else {
                this.columns[i].set(values, row);
            }

            offset += rows;
        }

        for (let i = 0; i < exceptionCount; i++) {
            const index = this.valueCount + slice.exceptionIndices[i];
            const field = index % fieldCount;

            this.exceptionRows[field].push((index - field) / fieldCount);
            this.exceptionValues[field].push(slice.exceptionValues[i] / this.divisors[field]);
        }

        this.valueCount += count;
    }

    finish(name: string): HeapSnapshotTable {
        const fieldCount = this.fields.length;
        const length = this.valueCount / fieldCount;
        const columns: Record<string, HeapSnapshotColumn> = {};

        if (this.valueCount % fieldCount !== 0 || (this.length !== null && length !== this.length)) {
            throw new Error(`Heap snapshot section "${name}" has ${this.valueCount} values for ${fieldCount} fields`);
        }

        for (let i = 0; i < fieldCount; i++) {
            const column = this.length === null
                ? joinChunks(this.chunks[i], Uint32Array)
                : this.columns[i];

            columns[this.fields[i]] = this.exceptionRows[i].length > 0
                ? withExceptions(column, this.exceptionRows[i], this.exceptionValues[i])
                : column;
        }

        return {
            length,
            columns
        };
    }
}

// A field of an enumeration type takes a byte, other fields take u32
function createColumn(length: number, type: string | string[] | null) {
    if (Array.isArray(type) && type.length <= 256) {
        return new Uint8Array(length);
    }

    return new Uint32Array(length);
}

function withExceptions(column: Uint8Array | Uint32Array, rows: number[], values: number[]) {
    const wide = new Float64Array(column);

    for (let i = 0; i < rows.length; i++) {
        wide[rows[i]] = values[i];
    }

    return wide;
}

// The chunks copied into one array, which keeps none of their buffers
function joinChunks<T extends Uint8Array | Uint32Array>(chunks: T[], Type: { new (length: number): T }) {
    let length = 0;

    for (let i = 0; i < chunks.length; i++) {
        length += chunks[i].length;
    }

    const joined = new Type(length);

    for (let i = 0, offset = 0; i < chunks.length; i++) {
        joined.set(chunks[i], offset);
        offset += chunks[i].length;
    }

    return joined;
}
