export class CallTree<T> {
    parent: Uint32Array;
    firstChild: Uint32Array;
    nextSibling: Uint32Array;
    nested: Uint32Array;

    constructor(
        public dictionary: T[],
        public mapToIndex: number[] | Uint32Array,
        public nodes: number[] | Uint32Array = new Uint32Array(dictionary.length)
    ) {
        this.parent = new Uint32Array(nodes.length);
        this.firstChild = new Uint32Array(nodes.length);
        this.nextSibling = new Uint32Array(nodes.length);
        this.nested = new Uint32Array(nodes.length);
    }

    *children(value) {
        let nodeIndex = this.firstChild[this.mapToIndex[value]];
        while (nodeIndex !== 0) {
            yield nodeIndex;
            nodeIndex = this.nextSibling[nodeIndex];
        }
    }
    *ancestors(nodeIndex) {
        nodeIndex = this.parent[nodeIndex];
        while (nodeIndex !== 0) {
            nodeIndex = this.parent[nodeIndex];
        }
    }
}
