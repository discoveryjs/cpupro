type Entry<T> = {
    nodeIndex: number;
    host: T;
    parent: Entry<T> | null;
    subtreeSize: number;
    children?: Entry<T>[];
};

type NumericArray =
    // | number[]
    // | Uint8Array
    // | Uint16Array
    | Uint32Array;

export class CallTree<T> {
    dictionary: T[];
    mapToIndex: NumericArray;
    root: Entry<T>;
    nodes: NumericArray;
    parent: NumericArray;
    subtreeSize: NumericArray;
    selfTimes: Uint32Array;
    nested: NumericArray;
    nestedTimes: Uint32Array;
    entries: Map<number, WeakRef<Entry<T>>>;

    constructor(
        dictionary: T[],
        mapToIndex: NumericArray,
        nodes?: NumericArray,
        parent?: NumericArray,
        subtreeSize?: NumericArray,
        nested?: NumericArray
    ) {
        this.dictionary = dictionary;
        this.mapToIndex = mapToIndex;
        this.nodes = nodes || new Uint32Array(dictionary.length);
        this.parent = parent || new Uint32Array(nodes.length);
        this.subtreeSize = subtreeSize || new Uint32Array(nodes.length);
        this.subtreeSize[0] = nodes.length - 1;
        this.selfTimes = new Uint32Array(nodes.length);
        this.nested = nested || new Uint32Array(nodes.length);
        this.nestedTimes = new Uint32Array(nodes.length);
        this.entries = new Map();

        // use Object.defineProperty() since jora iterates through own properties only
        Object.defineProperty(this, 'root', {
            enumerable: true,
            get: () => this.getEntry(0)
        });
    }

    createEntry(nodeIndex: number): Entry<T> {
        const entry = {
            nodeIndex,
            host: this.dictionary[this.nodes[nodeIndex]],
            parent: null,
            subtreeSize: this.subtreeSize[nodeIndex],
            selfTime: this.selfTimes[nodeIndex],
            totalTime: this.selfTimes[nodeIndex] + this.nestedTimes[nodeIndex]
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
