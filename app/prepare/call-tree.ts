type Entry<T> = {
    nodeIndex: number;
    value: T;
    parent: Entry<T> | null;
    subtreeSize: number;
    children?: Entry<T>[];
};

type NumericArray =
    // | number[]
    // | Uint8Array
    // | Uint16Array
    | Uint32Array;

type TestFunction<T> = (entry: T) => boolean;
type TestFunctionOrEntry<T> = T | TestFunction<T>;

const NULL_ARRAY = new Uint32Array();

function makeDictMask<T>(tree: CallTree<T>, test: TestFunctionOrEntry<T>) {
    const { dictionary } = tree;
    const accept = typeof test === 'function'
        ? test as TestFunction<T>
        : (entry: T) => entry === test;
    const mask = new Uint8Array(dictionary.length);

    for (let i = 0; i < mask.length; i++) {
        if (accept(dictionary[i])) {
            mask[i] = 1;
        }
    }

    return mask;
}

export class CallTree<T> {
    dictionary: T[];              // entries
    sourceIdToNode: NumericArray; // sourceNodeId -> index of nodes
    sampleIdToNode: NumericArray; // sampleId  -> index of nodes
    nodes: NumericArray;          // nodeIndex -> index of dictionary
    parent: NumericArray;         // nodeIndex -> index of nodes
    subtreeSize: NumericArray;    // nodeIndex -> number of nodes in subtree, 0 when no children
    nested: NumericArray;         // nodeIndex -> index of nodes

    valueNodes: NumericArray;
    valueNodesOffset: NumericArray;
    valueNodesLength: NumericArray;

    root: Entry<T>;
    #entryRefMap: Map<number, WeakRef<Entry<T>>>;
    #childrenRefMap: Map<number, WeakRef<Entry<T>[]>>;

    constructor(
        dictionary: T[],
        sourceIdToNode: NumericArray,
        nodes: NumericArray,
        parent?: NumericArray,
        subtreeSize?: NumericArray,
        nested?: NumericArray
    ) {
        this.dictionary = dictionary;
        this.sourceIdToNode = sourceIdToNode;
        this.sampleIdToNode = NULL_ARRAY; // setting up later

        this.nodes = nodes;
        this.parent = parent || new Uint32Array(nodes.length);
        this.subtreeSize = subtreeSize || new Uint32Array(nodes.length);
        this.nested = nested || new Uint32Array(nodes.length);

        this.valueNodes = new Uint32Array(nodes.length);
        this.valueNodesOffset = new Uint32Array(dictionary.length);
        this.valueNodesLength = new Uint32Array(dictionary.length);

        this.#entryRefMap = new Map();
        this.#childrenRefMap = new Map();

        // use Object.defineProperty() since jora iterates through own properties only
        Object.defineProperty(this, 'root', {
            enumerable: true,
            get: () => this.getEntry(0)
        });
    }

    computeValueNodes() {
        const { nodes, valueNodes, valueNodesLength, valueNodesOffset } = this;

        // compute length
        for (let i = 0; i < nodes.length; i++) {
            valueNodesLength[nodes[i]]++;
        }

        // compute offsets
        for (let i = 0, offset = 0; i < valueNodesLength.length; i++) {
            valueNodesOffset[i] = offset;
            offset += valueNodesLength[i];
        }

        // fill valueNodes
        for (let i = 0; i < valueNodes.length; i++) {
            valueNodes[valueNodesOffset[nodes[i]]++] = i;
        }

        // restore offsets
        for (let i = 0; i < valueNodesLength.length; i++) {
            valueNodesOffset[i] -= valueNodesLength[i];
        }

        return this;
    }

    createEntry(nodeIndex: number): Entry<T> {
        const entry = {
            nodeIndex,
            value: this.dictionary[this.nodes[nodeIndex]],
            parent: null,
            subtreeSize: this.subtreeSize[nodeIndex]
        };

        if (nodeIndex !== 0) {
            Object.defineProperty(entry, 'parent', {
                enumerable: true,
                get: () => this.getEntry(this.parent[nodeIndex])
            });
        }

        if (this.subtreeSize[nodeIndex]) {
            Object.defineProperty(entry, 'children', {
                enumerable: true,
                get: () => this.getChildren(nodeIndex)
            });
        }

        return entry;
    }
    getEntry(nodeIndex: number): Entry<T> {
        const entryRef = this.#entryRefMap.get(nodeIndex);
        let entry: Entry<T> | undefined;

        if (entryRef === undefined || (entry = entryRef.deref()) === undefined) {
            this.#entryRefMap.set(
                nodeIndex,
                new WeakRef(entry = this.createEntry(nodeIndex))
            );
        }

        return entry;
    }
    getChildren(nodeIndex: number): Entry<T>[] {
        const childrenRef = this.#childrenRefMap.get(nodeIndex);
        let children: Entry<T>[] | undefined;

        if (childrenRef === undefined || (children = childrenRef.deref()) === undefined) {
            this.#childrenRefMap.set(
                nodeIndex,
                new WeakRef(children = [...this.map(this.children(nodeIndex))])
            );
        }

        return children;
    }
    getValueSubtreesSize(value: number | T, includeSelf = true) {
        const { dictionary, nodes, subtreeSize } = this;
        let result = 0;
        let count = 0;

        if (typeof value !== 'number') {
            value = dictionary.indexOf(value);
        }

        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i] === value) {
                const size = subtreeSize[i];

                result += size;
                count++;

                // skip subtree scanning
                i += size;
            }
        }

        return includeSelf ? result + count : result;
    }

    *map(nodeIndexes: Iterable<number>) {
        for (const nodeIndex of nodeIndexes) {
            yield this.getEntry(nodeIndex);
        }
    }

    *selectNodes(value: number | T, includeNested = false) {
        const { dictionary, nested, valueNodes, valueNodesOffset, valueNodesLength } = this;

        if (typeof value !== 'number') {
            value = dictionary.indexOf(value);
        }

        const start = valueNodesOffset[value];
        const end = start + valueNodesLength[value];

        for (let i = start; i < end; i++) {
            const nodeIndex = valueNodes[i];

            if (includeNested || nested[nodeIndex] === 0) {
                yield nodeIndex;
            }
        }
    }
    *selectBy(test: TestFunctionOrEntry<T>) {
        const { nodes } = this;
        const mask = makeDictMask(this, test);
        const result = [];

        for (let i = 0; i < nodes.length; i++) {
            if (mask[nodes[i]]) {
                yield i;
            }
        }

        return result;
    }

    *ancestors(nodeIndex: number, depth = Infinity) {
        const { parent } = this;
        let parentIndex = parent[nodeIndex];

        while (parentIndex !== nodeIndex) {
            yield parentIndex;

            if (--depth <= 0) {
                break;
            }

            nodeIndex = parentIndex;
            parentIndex = parent[nodeIndex];
        }
    }
    *children(nodeIndex: number) {
        const { subtreeSize } = this;
        const end = nodeIndex + subtreeSize[nodeIndex];

        while (nodeIndex < end) {
            yield ++nodeIndex;

            nodeIndex += subtreeSize[nodeIndex];
        }
    }
    *subtree(nodeIndex: number) {
        const end = nodeIndex + this.subtreeSize[nodeIndex];

        while (nodeIndex < end) {
            yield ++nodeIndex;
        }
    }
}

export class FocusCallTree<T> extends CallTree<T> {
    timingsMap: Uint32Array;

    constructor(tree: CallTree<T>, value: number | T) {
        const outputTreeSize = tree.getValueSubtreesSize(value) + 1; // +1 for new root node

        super(tree.dictionary, tree.sourceIdToNode.slice(), new Uint32Array(outputTreeSize));

        this.timingsMap = new Uint32Array(outputTreeSize);
        this.nodes[0] = tree.nodes[0];
        this.subtreeSize[0] = outputTreeSize - 1;

        let offset = 1;
        for (const nodeIndex of tree.selectNodes(value)) {
            const size = tree.subtreeSize[nodeIndex];
            const newNodeIndex = offset++;
            const moveDelta = newNodeIndex - nodeIndex;

            this.timingsMap[newNodeIndex] = nodeIndex;

            if (size > 0) {
                const subtreeStart = nodeIndex;
                const subtreeEnd = subtreeStart + size + 1;

                for (let i = 1; i <= size; i++) {
                    this.timingsMap[offset] = nodeIndex + i;
                    this.parent[offset] = tree.parent[nodeIndex + i] + moveDelta;
                    offset++;
                }

                this.subtreeSize.set(tree.subtreeSize.subarray(subtreeStart, subtreeEnd), newNodeIndex);
                this.nested.set(tree.nested.subarray(subtreeStart, subtreeEnd), newNodeIndex);
                this.nodes.set(tree.nodes.subarray(subtreeStart, subtreeEnd), newNodeIndex);
            } else {
                this.nodes[newNodeIndex] = tree.nodes[nodeIndex];
            }
        }
    }
}
