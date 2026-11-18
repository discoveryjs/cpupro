import type { HeapSnapshotStringTable } from './formats/heap-snapshot-strings.js';
import type { HeapSnapshotTable, UniformHeapSnapshot, V8HeapSnapshot } from './formats/heap-snapshot.js';
import type { CpuProThread } from './types.js';

// The nodes of a type: their number and the sum of their self sizes
export type HeapSnapshotNodeType = {
    name: string;
    count: number;
    selfSize: number;
};

// A snapshot of the heap of a thread: its nodes (objects of the heap) and edges (references between them) by the
// fields of the snapshot's meta, the strings they name, and the other sections of the snapshot
export type HeapSnapshot = {
    thread: CpuProThread;
    snapshot: V8HeapSnapshot['snapshot'];
    nodes: HeapSnapshotTable;
    edges: HeapSnapshotTable;
    strings: HeapSnapshotStringTable;
    sections: Record<string, unknown>;
    selfSize: number;
    nodeTypes: HeapSnapshotNodeType[];
};

export function createHeapSnapshot(data: UniformHeapSnapshot, thread: CpuProThread): HeapSnapshot {
    const { snapshot, nodes, edges, strings, sections } = data;
    const nodeTypes = summarizeNodeTypes(snapshot, nodes);
    let selfSize = 0;

    for (let i = 0; i < nodeTypes.length; i++) {
        selfSize += nodeTypes[i].selfSize;
    }

    return {
        thread,
        snapshot,
        nodes,
        edges,
        strings,
        sections,
        selfSize,
        nodeTypes
    };
}

// The types of the meta with their nodes
function summarizeNodeTypes(snapshot: V8HeapSnapshot['snapshot'], nodes: HeapSnapshotTable): HeapSnapshotNodeType[] {
    const names = snapshot.meta.node_types[snapshot.meta.node_fields.indexOf('type')] as string[];
    const types = nodes.columns.type;
    const selfSizes = nodes.columns.self_size;
    const counts = new Uint32Array(names.length);
    const sizes = new Float64Array(names.length);

    for (let i = 0; i < nodes.length; i++) {
        const type = types[i];

        counts[type]++;
        sizes[type] += selfSizes[i];
    }

    return names.map((name, type) => ({
        name,
        count: counts[type],
        selfSize: sizes[type]
    }));
}
