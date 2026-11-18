import assert from 'node:assert/strict';
import { getHeapSnapshot } from 'node:v8';
import { test } from 'vitest';
import { decode, type HeapSnapshotTable, type V8HeapSnapshot } from './heap-snapshot.js';
import { SLICE_SIZE } from './heap-snapshot.compute.js';

type JsonSnapshot = Record<string, unknown> & {
    snapshot: V8HeapSnapshot['snapshot'];
    strings: string[];
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
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'];
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];

// A snapshot of a root with two objects: the root holds both, the first holds the second by a weak edge
function currentLayout(): JsonSnapshot {
    return {
        snapshot: {
            meta: {
                node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
                node_types: [nodeTypes, 'string', 'number', 'number', 'number', 'number'],
                edge_fields: ['type', 'name_or_index', 'to_node'],
                edge_types: [edgeTypes, 'string_or_number', 'node'],
                location_fields: ['object_index', 'script_id', 'script_object_index', 'line', 'column'],
                scope_fields: ['script_node_index', 'scope_id', 'depth', 'scope_context_vars_count', 'scope_uses_count'],
                scope_context_var_fields: ['name'],
                scope_use_fields: ['declaring_scope_id', 'slot_index']
            },
            node_count: 3,
            edge_count: 3,
            trace_function_count: 0,
            extra_native_bytes: 0
        },
        nodes: [
            9, 1, 1, 0, 2, 0,
            3, 2, 3, 32, 1, 0,
            3, 3, 5, 5000000000, 0, 2
        ],
        edges: [
            2, 4, 6,
            1, 0, 12,
            6, 4, 12
        ],
        trace_function_infos: [],
        trace_tree: [],
        samples: [],
        locations: [6, 7, 12, 10, 2],
        scopes: [12, -1, 0, 1, 0, 12, 3, 1, 0, 1],
        scope_context_vars: [5],
        scope_uses: [-2, 0],
        strings: ['<dummy>', '', 'Foo', 'a "quoted" \\ ] string', 'привет\n']
    };
}

// Allocation tracking adds trace node ids, trace function infos, the trace tree and samples; no scopes or script
// object indices yet
function trackingLayout(): JsonSnapshot {
    return {
        snapshot: {
            meta: {
                node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
                node_types: [nodeTypes, 'string', 'number', 'number', 'number', 'number', 'number'],
                edge_fields: ['type', 'name_or_index', 'to_node'],
                edge_types: [edgeTypes, 'string_or_number', 'node'],
                trace_function_info_fields: ['function_id', 'name', 'script_name', 'script_id', 'line', 'column'],
                trace_node_fields: ['id', 'function_info_index', 'count', 'size', 'children'],
                sample_fields: ['timestamp_us', 'last_assigned_id'],
                location_fields: ['object_index', 'script_id', 'line', 'column']
            },
            node_count: 2,
            edge_count: 1,
            trace_function_count: 1
        },
        nodes: [
            9, 1, 1, 0, 1, 0, 0,
            5, 2, 3, 64, 0, 2, 0
        ],
        edges: [
            2, 2, 7
        ],
        trace_function_infos: [0, 1, 2, 3, 4, 5],
        trace_tree: [1, 0, 0, 0, [2, 0, 1, 64, []]],
        samples: [0, 1, 5000000000, 3],
        locations: [7, 3, 0, 0],
        strings: ['<dummy>', '(root)', 'fn']
    };
}

// V8's form: sections in order, each after a new line
function serialize(snapshot: Record<string, unknown>) {
    return '{' + Object.entries(snapshot)
        .map(([name, value]) => JSON.stringify(name) + ':' + JSON.stringify(value))
        .join(',\n') + '}';
}

async function decodeBytes(bytes: Uint8Array, chunkSize: number) {
    async function* chunks() {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            yield bytes.slice(offset, offset + chunkSize);
        }
    }

    return decode(chunks());
}

// Every section of numbers described by the meta has the values of the JSON in columns by field, a node field
// the index of the node; the strings and other sections are as in the JSON
function assertDecoded(decoded: V8HeapSnapshot, json: JsonSnapshot) {
    const meta = json.snapshot.meta;
    const fieldTypes: Record<string, (string | string[])[]> = {
        nodes: meta.node_types,
        edges: meta.edge_types
    };

    assert.deepEqual(decoded.snapshot, json.snapshot);
    assert.deepEqual(decoded.strings.values, json.strings);
    assert.deepEqual(
        Array.from({ length: decoded.strings.length }, (_, index) => decoded.strings.get(index)),
        json.strings
    );

    for (const name of Object.keys(json)) {
        const fields = meta[sectionFields[name]] as string[] | undefined;

        if (name === 'snapshot' || name === 'strings') {
            continue;
        }

        if (fields === undefined) {
            assert.deepEqual(decoded[name], json[name], name);
            continue;
        }

        const types = fieldTypes[name] ?? [];
        const table = decoded[name] as HeapSnapshotTable;
        const values = json[name] as number[];

        assert.equal(table.length, values.length / fields.length, name);

        for (let i = 0; i < fields.length; i++) {
            const divisor = types[i] === 'node' ? meta.node_fields.length : 1;
            const expected: number[] = [];

            for (let j = i; j < values.length; j += fields.length) {
                expected.push(values[j] / divisor);
            }

            assert.deepEqual(Array.from(table.columns[fields[i]]), expected, `${name}.${fields[i]}`);
        }
    }
}

test('sections of several V8 layouts decode in chunks of any size', async () => {
    for (const json of [currentLayout(), trackingLayout()]) {
        const bytes = new TextEncoder().encode(serialize(json));

        for (const chunkSize of [1, 2, 3, 5, 8, 13, bytes.length]) {
            assertDecoded(await decodeBytes(bytes, chunkSize), json);
        }
    }
});

test('values out of u32 range make Float64Array columns, enumerations take bytes', async () => {
    const decoded = await decodeBytes(new TextEncoder().encode(serialize(currentLayout())), 7);
    const tracking = await decodeBytes(new TextEncoder().encode(serialize(trackingLayout())), 7);

    assert.deepEqual(decoded.nodes.columns.self_size, new Float64Array([0, 32, 5000000000]));
    assert.deepEqual(decoded.nodes.columns.type, new Uint8Array([9, 3, 3]));
    assert.deepEqual(decoded.edges.columns.to_node, new Uint32Array([1, 2, 2]));
    assert.deepEqual((decoded.scopes as HeapSnapshotTable).columns.scope_id, new Float64Array([-1, 3]));
    assert.deepEqual((tracking.samples as HeapSnapshotTable).columns.timestamp_us, new Float64Array([0, 5000000000]));
});

test('values may be separated by white space, as older V8 versions wrote nodes by lines', async () => {
    const json = currentLayout();
    const text = serialize(json).replace('"nodes":[9,1,1,0,2,0,', '"nodes":[9,1,1,0,2,0\n,');

    assertDecoded(await decodeBytes(new TextEncoder().encode(text), 4), json);
});

test('a section longer than a slice of the scan', async () => {
    const json = trackingLayout();
    const nodeCount = Math.ceil(SLICE_SIZE / 10);
    const nodes: number[] = [];

    for (let i = 0; i < nodeCount; i++) {
        nodes.push(3, 2, 2 * i + 1, i, 0, 0, i % 2);
    }

    json.snapshot.node_count = nodeCount;
    json.nodes = nodes;
    json.edges = [];
    json.snapshot.edge_count = 0;

    const bytes = new TextEncoder().encode(serialize(json));

    assertDecoded(await decodeBytes(bytes, bytes.length), json);
    assertDecoded(await decodeBytes(bytes, 100003), json);
});

test('a snapshot of the running V8 matches its JSON', async () => {
    const chunks: Uint8Array[] = [];

    for await (const chunk of getHeapSnapshot()) {
        chunks.push(chunk);
    }

    const bytes = Buffer.concat(chunks);
    const json = JSON.parse(bytes.toString()) as JsonSnapshot;

    assertDecoded(await decodeBytes(bytes, 65536), json);
});

test('an incomplete snapshot is rejected', async () => {
    const bytes = new TextEncoder().encode(serialize(currentLayout()));

    await assert.rejects(decodeBytes(bytes.subarray(0, bytes.length - 1), 16), /incomplete/);
    await assert.rejects(
        decodeBytes(new TextEncoder().encode(serialize({ ...currentLayout(), edges: [2, 4, 6] })), 16),
        /"edges" has 3 values/
    );
});
