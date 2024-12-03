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

export type SampleConvolutionRule<T> = (
    self: SampleConvolutionNode<T>,
    parent: SampleConvolutionNode<T>,
    root: SampleConvolutionNode<T>
) => boolean;
type SampleConvolutionNode<T> = {
    entry: T;
    treeSamplesCount: number;
    dictSamplesCount: number;
    profilePresence: number;
};

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
    sourceIdToNode: Int32Array;   // sourceNodeId -> index of nodes
    sampleIdToNode: NumericArray; // sampleId  -> index of nodes
    #sampleIdToNode: NumericArray;
    sampleIdToNodeChanged: boolean; // FIXME: temporary solution to avoid unnecessary dict recalculations
    nodes: NumericArray;          // nodeIndex -> index of dictionary
    parent: NumericArray;         // nodeIndex -> index of nodes
    subtreeSize: NumericArray;    // nodeIndex -> number of nodes in subtree, 0 when no children
    nested: NumericArray;         // nodeIndex -> index of nodes

    // The following arrays are used for fast selection of nodes that refer to a specific entry in the dictionary.
    // Generally, nodes are rearranged to ensure that all of an entry's nodes follow one continuous sequence. This allows
    // for fast selections like:
    //
    //   const start = tree.entryNodesOffset[entryIndex];
    //   const end = start + tree.entryNodesCount[entryIndex];
    //   entryNodes.slice(start, end)
    //
    entryNodes: NumericArray;       // node indices
    entryNodesOffset: NumericArray; // start offset for a sequence of entry's node indices: entry index -> offset in entryNodes
    entryNodesCount: NumericArray;  // length of sequence for entry's node indices, or the number of nodes per entry

    root: Entry<T>;
    #entryRefMap: Map<number, WeakRef<Entry<T>>>;
    #childrenRefMap: Map<number, WeakRef<Entry<T>[]>>;

    constructor(
        dictionary: T[],
        sourceIdToNode: Int32Array,
        nodes: NumericArray,
        parent?: NumericArray,
        subtreeSize?: NumericArray,
        nested?: NumericArray
    ) {
        this.dictionary = dictionary;
        this.sourceIdToNode = sourceIdToNode;
        this.sampleIdToNode = NULL_ARRAY; // setting up later
        this.#sampleIdToNode = NULL_ARRAY;
        this.sampleIdToNodeChanged = false;

        this.nodes = nodes;
        this.parent = parent || new Uint32Array(nodes.length);
        this.subtreeSize = subtreeSize || new Uint32Array(nodes.length);
        this.nested = nested || new Uint32Array(nodes.length);

        this.entryNodes = NULL_ARRAY; // overrides by computeEntryNodes()
        this.entryNodesOffset = NULL_ARRAY;
        this.entryNodesCount = NULL_ARRAY;

        this.#entryRefMap = new Map();
        this.#childrenRefMap = new Map();

        // use Object.defineProperty() since jora iterates through own properties only
        Object.defineProperty(this, 'root', {
            enumerable: true,
            get: () => this.getEntry(0)
        });
    }

    computeEntryNodes() {
        // skip computations if already done
        if (this.entryNodes !== NULL_ARRAY) {
            return this;
        }

        const { nodes, dictionary } = this;
        const entryNodes = new Uint32Array(nodes.length);
        const entryNodesOffset = new Uint32Array(dictionary.length);
        const entryNodesCount = new Uint32Array(dictionary.length);

        // compute length
        for (let i = 0; i < nodes.length; i++) {
            entryNodesCount[nodes[i]]++;
        }

        // compute offsets
        for (let i = 0, offset = 0; i < entryNodesCount.length; i++) {
            entryNodesOffset[i] = offset;
            offset += entryNodesCount[i];
        }

        // fill entryNodes
        for (let i = 0; i < entryNodes.length; i++) {
            entryNodes[entryNodesOffset[nodes[i]]++] = i;
        }

        // restore offsets
        for (let i = 0; i < entryNodesCount.length; i++) {
            entryNodesOffset[i] -= entryNodesCount[i];
        }

        // store new arrays on the tree
        this.entryNodes = entryNodes;
        this.entryNodesOffset = entryNodesOffset;
        this.entryNodesCount = entryNodesCount;

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

    setSamplesConvolutionRule(rule: SampleConvolutionRule<T>, {
        treeSamplesCount,
        dictSamplesCount,
        profilePresence
    }:{
        treeSamplesCount: Uint32Array,
        dictSamplesCount: Uint32Array,
        profilePresence: Float32Array
    }) {
        const { parent, nodes, sampleIdToNode } = this;
        const nodesRemap = nodes.slice();
        let origSampleIdToNode = this.#sampleIdToNode;
        const createEntry = (index: number) => ({
            entry: this.dictionary[nodes[index]],
            treeSamplesCount: treeSamplesCount[index],
            dictSamplesCount: dictSamplesCount[index],
            profilePresence: profilePresence[nodes[index]]
        });

        for (let i = 1; i < nodesRemap.length; i++) {
            const parentNode = parent[i];
            const rootNode = nodesRemap[parentNode];
            const selfEntry = createEntry(i);
            const parentEntry = createEntry(parentNode);
            const rootEntry = rootNode === parentNode
                ? parentEntry
                : createEntry(rootNode);

            nodesRemap[i] = rule(selfEntry, parentEntry, rootEntry) === true ? rootNode : i;
        }

        if (origSampleIdToNode === NULL_ARRAY) {
            this.#sampleIdToNode = origSampleIdToNode = sampleIdToNode.slice();
        }

        for (let i = 0; i < sampleIdToNode.length; i++) {
            sampleIdToNode[i] = nodesRemap[origSampleIdToNode[i]];
        }

        // FIXME: temporary solution to avoid unnecessary dict recalculations
        this.sampleIdToNodeChanged = true;
    }

    *map(nodeIndexes: Iterable<number>) {
        for (const nodeIndex of nodeIndexes) {
            yield this.getEntry(nodeIndex);
        }
    }

    *selectNodes(value: number | T, includeNested = false) {
        const { dictionary, nested, entryNodes, entryNodesOffset, entryNodesCount } = this;

        if (typeof value !== 'number') {
            value = dictionary.indexOf(value);
        }

        const start = entryNodesOffset[value];
        const end = start + entryNodesCount[value];

        for (let i = start; i < end; i++) {
            const nodeIndex = entryNodes[i];

            if (includeNested || nested[nodeIndex] === 0) {
                yield nodeIndex;
            }
        }
    }
    *selectBy(test: TestFunctionOrEntry<T>, includeNested = false) {
        const { nodes, nested } = this;
        const mask = makeDictMask(this, test);
        const result = [];

        for (let i = 0; i < nodes.length; i++) {
            if (mask[nodes[i]] && (includeNested || nested[i] === 0)) {
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
