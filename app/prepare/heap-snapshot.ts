import type { HeapSnapshotStringTable } from './formats/heap-snapshot-strings.js';
import type { HeapSnapshotTable, UniformHeapSnapshot, V8HeapSnapshot } from './formats/heap-snapshot.js';
import type { CpuProThread } from './types.js';
import { exposeGetters } from './computations/misc.js';
import {
    computeDistances,
    computeDominatorTree,
    computeFirstEdges,
    computeRetainers
} from './heap-snapshot-graph.js';
import { classObjects, createObjectList, type HeapSnapshotObject } from './heap-snapshot-objects.js';

// The nodes of a type: their number and the sum of their self sizes
export type HeapSnapshotNodeType = {
    name: string;
    count: number;
    selfSize: number;
};

// The nodes of a class: objects and natives of a constructor name, nodes of another type by their type. The indices
// of its nodes are found when read and kept while something holds them
export type HeapSnapshotClass = {
    index: number;
    name: string;
    type: string;
    count: number;
    selfSize: number;
    readonly objects: Uint32Array;
};

// A snapshot of the heap of a thread: its nodes (objects of the heap) and edges (references between them) by the
// fields of the snapshot's meta, the strings they name, the other sections of the snapshot, and the classes of nodes.
// The graph of the nodes (first edges, retainers, the dominator tree and retained sizes, distances from the root)
// is computed when read and kept with the snapshot. PERF: The graph takes seconds over tens of millions of nodes,
// while the classes, which the views of a snapshot start with, take tens of ms
export class HeapSnapshot {
    thread: CpuProThread;
    snapshot: V8HeapSnapshot['snapshot'];
    nodes: HeapSnapshotTable;
    edges: HeapSnapshotTable;
    strings: HeapSnapshotStringTable;
    sections: Record<string, unknown>;
    classes: HeapSnapshotClass[];
    nodeClasses: Uint32Array; // per node: the index of its class
    objects: readonly HeapSnapshotObject[]; // by the indices of nodes, made when read
    nodeTypes: HeapSnapshotNodeType[];
    selfSize: number;

    #firstEdges: Uint32Array | null = null;
    #retainers: ReturnType<typeof computeRetainers> | null = null;
    #dominatorTree: { dominators: Uint32Array; retainedSizes: Float64Array } | null = null;
    #distances: Uint32Array | null = null;

    constructor(data: UniformHeapSnapshot, thread: CpuProThread) {
        const { snapshot, nodes, edges, strings, sections } = data;
        const { classes, nodeClasses } = classifyNodes(snapshot, nodes, strings);
        const nodeTypes = summarizeNodeTypes(snapshot, classes);
        let selfSize = 0;

        for (let i = 0; i < nodeTypes.length; i++) {
            selfSize += nodeTypes[i].selfSize;
        }

        this.thread = thread;
        this.snapshot = snapshot;
        this.nodes = nodes;
        this.edges = edges;
        this.strings = strings;
        this.sections = sections;
        this.classes = classes;
        this.nodeClasses = nodeClasses;
        this.nodeTypes = nodeTypes;
        this.selfSize = selfSize;
        this.objects = createObjectList(this);

        for (let i = 0; i < classes.length; i++) {
            defineClassObjects(this, classes[i]);
        }

        exposeGetters(this, HeapSnapshot.prototype, [
            'firstEdges',
            'retainers',
            'dominators',
            'retainedSizes',
            'distances'
        ]);
    }

    // Per node: the index of its first edge, then the number of edges
    get firstEdges(): Uint32Array {
        if (this.#firstEdges === null) {
            this.#firstEdges = computeFirstEdges(this.nodes.columns.edge_count, this.nodes.length);
        }

        return this.#firstEdges;
    }

    // The edges to every node: firstRetainers per node, then retainerEdges
    get retainers() {
        if (this.#retainers === null) {
            this.#retainers = computeRetainers(this.edges.columns.to_node as Uint32Array, this.nodes.length);
        }

        return this.#retainers;
    }

    // Per node: its immediate dominator, NO_NODE for the root and nodes out of reach of strong edges
    get dominators(): Uint32Array {
        return this.#getDominatorTree().dominators;
    }

    // Per node: the memory freed with it, its self size and the self sizes of the nodes it dominates
    get retainedSizes(): Float64Array {
        return this.#getDominatorTree().retainedSizes;
    }

    // Per node: the number of strong edges on a shortest path from the root, NO_NODE out of reach
    get distances(): Uint32Array {
        if (this.#distances === null) {
            this.#distances = computeDistances(
                this.firstEdges,
                this.edges.columns.to_node as Uint32Array,
                this.edges.columns.type as Uint8Array,
                this.#weakEdgeType()
            );
        }

        return this.#distances;
    }

    // A snapshot may come with its dominator tree, the columns of the immediate dominator of every node (its index,
    // NO_NODE for the root and nodes out of reach) and its retained size
    #getDominatorTree() {
        const { dominator, retained_size: retainedSize } = this.nodes.columns;

        if (this.#dominatorTree === null && dominator !== undefined && retainedSize !== undefined) {
            this.#dominatorTree = {
                dominators: dominator as Uint32Array,
                retainedSizes: retainedSize instanceof Float64Array
                    ? retainedSize
                    : Float64Array.from(retainedSize)
            };
        }

        if (this.#dominatorTree === null) {
            this.#dominatorTree = computeDominatorTree(
                this.firstEdges,
                this.edges.columns.to_node as Uint32Array,
                this.edges.columns.type as Uint8Array,
                this.#weakEdgeType(),
                this.nodes.columns.self_size
            );
        }

        return this.#dominatorTree;
    }

    #weakEdgeType() {
        return edgeTypeNames(this.snapshot).indexOf('weak');
    }
}

function defineClassObjects(snapshot: HeapSnapshot, nodeClass: HeapSnapshotClass) {
    let objects: WeakRef<Uint32Array> | null = null;

    Object.defineProperty(nodeClass, 'objects', {
        enumerable: true,
        get() {
            let indices = objects?.deref();

            if (indices === undefined) {
                indices = classObjects(snapshot, nodeClass.index);
                objects = new WeakRef(indices);
            }

            return indices;
        }
    });
}

// Classes of nodes: an object or a native takes the class of its name, of its type apart, another node the class of
// its type. Classes of types go first, by their indices; classes of names follow in the order of their first nodes
function classifyNodes(snapshot: V8HeapSnapshot['snapshot'], nodes: HeapSnapshotTable, strings: HeapSnapshotStringTable) {
    const typeNames = nodeTypeNames(snapshot);
    const objectType = typeNames.indexOf('object');
    const nativeType = typeNames.indexOf('native');
    const types = nodes.columns.type;
    const names = nodes.columns.name;
    const selfSizes = nodes.columns.self_size;
    const nodeClasses = new Uint32Array(nodes.length);
    // PERF: Classes of names are found by the index of the name, objects and natives apart, rather than a Map
    const nameClasses = new Int32Array(2 * strings.length).fill(-1);
    const classNames: number[] = [];
    let classCount = typeNames.length;

    for (let i = 0; i < nodes.length; i++) {
        const type = types[i];

        if (type !== objectType && type !== nativeType) {
            nodeClasses[i] = type;
            continue;
        }

        const key = type === nativeType
            ? 2 * names[i] + 1
            : 2 * names[i];
        let nodeClass = nameClasses[key];

        if (nodeClass === -1) {
            nodeClass = classCount++;
            nameClasses[key] = nodeClass;
            classNames.push(key);
        }

        nodeClasses[i] = nodeClass;
    }

    const counts = new Uint32Array(classCount);
    const sizes = new Float64Array(classCount);
    const classes: Omit<HeapSnapshotClass, 'objects'>[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const nodeClass = nodeClasses[i];

        counts[nodeClass]++;
        sizes[nodeClass] += selfSizes[i];
    }

    for (let i = 0; i < typeNames.length; i++) {
        classes.push({
            index: i,
            name: `(${typeNames[i]})`,
            type: typeNames[i],
            count: counts[i],
            selfSize: sizes[i]
        });
    }

    for (let i = typeNames.length; i < classCount; i++) {
        const key = classNames[i - typeNames.length];
        const type = key & 1
            ? nativeType
            : objectType;

        classes.push({
            index: i,
            name: strings.get(key >> 1),
            type: typeNames[type],
            count: counts[i],
            selfSize: sizes[i]
        });
    }

    // the objects of classes are defined by the snapshot
    return {
        classes: classes as HeapSnapshotClass[],
        nodeClasses
    };
}

// The types of the meta with their nodes, summed over classes
function summarizeNodeTypes(snapshot: V8HeapSnapshot['snapshot'], classes: HeapSnapshotClass[]): HeapSnapshotNodeType[] {
    const nodeTypes = nodeTypeNames(snapshot).map(name => ({
        name,
        count: 0,
        selfSize: 0
    }));
    const typeByName = new Map(nodeTypes.map(nodeType => [nodeType.name, nodeType]));

    for (let i = 0; i < classes.length; i++) {
        const nodeType = typeByName.get(classes[i].type)!;

        nodeType.count += classes[i].count;
        nodeType.selfSize += classes[i].selfSize;
    }

    return nodeTypes;
}

export function nodeTypeNames(snapshot: V8HeapSnapshot['snapshot']) {
    return snapshot.meta.node_types[snapshot.meta.node_fields.indexOf('type')] as string[];
}

export function edgeTypeNames(snapshot: V8HeapSnapshot['snapshot']) {
    return snapshot.meta.edge_types[snapshot.meta.edge_fields.indexOf('type')] as string[];
}
