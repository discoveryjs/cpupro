import { edgeTypeNames, nodeTypeNames, type HeapSnapshot, type HeapSnapshotClass } from './heap-snapshot.js';
import { edgeOwner } from './heap-snapshot-graph.js';

// A reference of a snapshot's object: its type, its name (a property name, or an index of an element or a hidden
// edge) and the indices of the nodes it is from and to
export type HeapSnapshotReference = {
    type: string;
    name: string | number;
    from: number;
    to: number;
};

// An object of a snapshot: a node with its fields, and its references taken when read, the references of the object
// (edges) and to it (retainers). PERF: Retainers of an object are found by a scan of the targets of edges, tens
// of ms over a hundred million edges, while an index of all retainers takes hundreds of ms
export type HeapSnapshotObject = {
    snapshot: HeapSnapshot;
    index: number;
    id: number;
    type: string;
    name: string;
    selfSize: number;
    class: HeapSnapshotClass;
    readonly edges: HeapSnapshotReference[];
    readonly retainers: HeapSnapshotReference[];
};

// The objects of a snapshot by the indices of their nodes, an object is made when it's read and kept while
// something holds it. The list has the length of the nodes and no other keys, so it isn't enumerated
export function createObjectList(snapshot: HeapSnapshot): readonly HeapSnapshotObject[] {
    const refs = new Map<number, WeakRef<HeapSnapshotObject>>();
    const nodeCount = snapshot.nodes.length;
    const getObject = (index: number) => {
        let object = refs.get(index)?.deref();

        if (object === undefined) {
            object = createObject(snapshot, index);
            refs.set(index, new WeakRef(object));
        }

        return object;
    };

    return new Proxy([], {
        get(target, key) {
            if (key === 'length') {
                return nodeCount;
            }

            const index = typeof key === 'string'
                ? Number(key)
                : NaN;

            if (Number.isInteger(index) && index >= 0 && index < nodeCount) {
                return getObject(index);
            }

            return Reflect.get(target, key);
        }
    });
}

// The indices of the nodes of a class in their order
export function classObjects(snapshot: HeapSnapshot, nodeClass: number) {
    const { nodeClasses } = snapshot;
    const indices = new Uint32Array(snapshot.classes[nodeClass].count);
    let count = 0;

    for (let i = 0; i < nodeClasses.length; i++) {
        if (nodeClasses[i] === nodeClass) {
            indices[count++] = i;
        }
    }

    return indices;
}

function createObject(snapshot: HeapSnapshot, index: number): HeapSnapshotObject {
    const { type, name, id, self_size: selfSize } = snapshot.nodes.columns;
    const object = {
        snapshot,
        index,
        id: id[index],
        type: nodeTypeNames(snapshot.snapshot)[type[index]],
        name: snapshot.strings.get(name[index]),
        selfSize: selfSize[index],
        class: snapshot.classes[snapshot.nodeClasses[index]]
    } as HeapSnapshotObject;
    let edges: HeapSnapshotReference[] | null = null;
    let retainers: HeapSnapshotReference[] | null = null;

    // the references are kept with the object
    Object.defineProperties(object, {
        edges: {
            enumerable: true,
            get: () => edges ??= objectEdges(snapshot, index)
        },
        retainers: {
            enumerable: true,
            get: () => retainers ??= objectRetainers(snapshot, index)
        }
    });

    return object;
}

// The edges of an object in their order
function objectEdges(snapshot: HeapSnapshot, index: number) {
    const { firstEdges } = snapshot;
    const end = firstEdges[index + 1];
    const references: HeapSnapshotReference[] = [];

    for (let i = firstEdges[index]; i < end; i++) {
        references.push(createReference(snapshot, i, index));
    }

    return references;
}

// The edges to an object in the order of their owners
function objectRetainers(snapshot: HeapSnapshot, index: number) {
    const toNodes = snapshot.edges.columns.to_node as Uint32Array;
    const { firstEdges } = snapshot;
    const references: HeapSnapshotReference[] = [];

    for (let i = toNodes.indexOf(index); i !== -1; i = toNodes.indexOf(index, i + 1)) {
        references.push(createReference(snapshot, i, edgeOwner(firstEdges, i)));
    }

    return references;
}

// An element or a hidden edge is named by an index, other edges by a string
function createReference(snapshot: HeapSnapshot, edge: number, from: number): HeapSnapshotReference {
    const { type, name_or_index: nameOrIndex, to_node: toNodes } = snapshot.edges.columns;
    const typeName = edgeTypeNames(snapshot.snapshot)[type[edge]];
    const name = typeName === 'element' || typeName === 'hidden'
        ? nameOrIndex[edge]
        : snapshot.strings.get(nameOrIndex[edge]);

    return {
        type: typeName,
        name,
        from,
        to: toNodes[edge]
    };
}
