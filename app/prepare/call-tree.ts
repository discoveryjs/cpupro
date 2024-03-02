type Entry<T> = {
    nodeIndex: number;
    subject: T;
    parent: Entry<T> | null;
    subtreeSize: number;
    children?: Entry<T>[];
};

type NumericArray =
    | number[]
    | Uint8Array
    | Uint16Array
    | Uint32Array;

export class CallTree<T> {
    root: Entry<T>;
    parent: NumericArray;
    subtreeSize: NumericArray;
    selfTimes: NumericArray;
    nested: NumericArray;
    nestedTimes: NumericArray;
    entries: Map<number, WeakRef<Entry<T>>>;

    constructor(
        public dictionary: T[],
        public mapToIndex: NumericArray,
        public nodes: NumericArray = new Uint32Array(dictionary.length)
    ) {
        this.parent = new Uint32Array(nodes.length);
        this.subtreeSize = new Uint32Array(nodes.length);
        this.subtreeSize[0] = nodes.length - 1;
        this.selfTimes = new Uint32Array(nodes.length);
        this.nested = new Uint32Array(nodes.length);
        this.nestedTimes = new Uint32Array(nodes.length);
        this.entries = new Map();

        Object.defineProperty(this, 'root', {
            enumerable: true,
            get: () => this.getEntry(0)
        });
    }

    // get root() {
    //     debugger;
    //     return this.getEntry(0);
    // }

    createEntry(nodeIndex: number): Entry<T> {
        const entry = {
            nodeIndex,
            subject: this.dictionary[this.nodes[nodeIndex]],
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
                configurable: true,
                enumerable: true,
                get: () => {
                    const value = [...this.map(this.children(nodeIndex))];
                    Object.defineProperty(entry, 'children', {
                        enumerable: true,
                        value
                    });
                    return value;
                }
            });
        }

        return entry;
    }
    getEntry(nodeIndex: number): Entry<T> {
        const entryRef = this.entries.get(nodeIndex);
        let entry;

        if (entryRef === undefined || (entry = entryRef.deref()) === undefined) {
            this.entries.set(nodeIndex, new WeakRef(entry = this.createEntry(nodeIndex)));
        }

        return entry;
    }

    *map(nodeIndecies: Iterable<number>) {
        for (const nodeIndex of nodeIndecies) {
            yield this.getEntry(nodeIndex);
        }
    }

    *selectNodes(value: number) {
        for (let i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i] === value) {
                yield i;
            }
        }
    }

    *children(nodeIndex: number) {
        const end = nodeIndex + this.subtreeSize[nodeIndex];

        while (nodeIndex < end) {
            yield ++nodeIndex;
            nodeIndex += this.subtreeSize[nodeIndex];
        }
    }
    *ancestors(nodeIndex: number) {
        nodeIndex = this.parent[nodeIndex];

        while (nodeIndex !== 0) {
            yield nodeIndex;
            nodeIndex = this.parent[nodeIndex];
        }
    }
}
