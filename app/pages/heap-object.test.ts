import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import prepare from '../setup-prepare.mjs';
import { decode } from '../prepare/formats/heap-snapshot.js';

const pages = new Map();

vi.stubGlobal('discovery', { page: { define: (name: string, config: object) => pages.set(name, config) } });
try {
    await import('./heap-object.js');
} finally {
    vi.unstubAllGlobals();
}

const snapshotText = JSON.stringify({
    snapshot: {
        meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
            node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'], 'string', 'number', 'number', 'number', 'number'],
            edge_fields: ['type', 'name_or_index', 'to_node'],
            edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node']
        },
        node_count: 2,
        edge_count: 1,
        trace_function_count: 0
    },
    nodes: [9, 1, 1, 0, 1, 0, 3, 2, 7, 16, 0, 0],
    edges: [2, 2, 6],
    strings: ['<dummy>', '', 'Foo']
});

async function* bytes() {
    yield new TextEncoder().encode(snapshotText);
}

// The page takes the object of a snapshot by the id in its reference
test('the heap object page finds an object by its id', async () => {
    const data = await prepare(await decode(bytes()), {
        rejectData: (reason: string) => assert.fail(reason),
        markers: new Proxy({}, { get: () => () => {} }),
        setWorkTitle: async () => {}
    } as unknown as Parameters<typeof prepare>[1]);
    const page = pages.get('heap-object') as { data: string };
    const query = jora(page.data);

    assert.equal(query(data, { id: '7' }), data.heapSnapshots[0].objects[1]);
    assert.equal(query(data, { id: '3' }), undefined);
});
