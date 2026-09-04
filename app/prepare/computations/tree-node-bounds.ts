import type { CpuProNode } from '../types.js';
import type { CallTree } from './call-tree.js';
import type { DictionaryMetric } from './metrics.js';

export type DictionaryBounds<T> = {
    entryIndex: number;
    entry: T;
    firstSeen: number;
    lastSeen: number;
};

export class TreeValueBounds<T extends CpuProNode> {
    #seenVectors: WeakRef<{ firstSeen: Uint32Array; lastSeen: Uint32Array }>;
    #entries: WeakRef<DictionaryBounds<T>[]>;
    #entriesMap: WeakRef<Map<T, DictionaryMetric<T>>>;
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    cumulative: Uint32Array;
    samples: Uint32Array;
    firstSeen: Uint32Array;
    lastSeen: Uint32Array;

    constructor(tree: CallTree<T>, sampleToNode: Uint32Array, cumulative: Uint32Array, samples: Uint32Array) {
        this.tree = tree;
        this.sampleToNode = sampleToNode;
        this.cumulative = cumulative;
        this.samples = samples;

        Object.defineProperties(this, {
            firstSeen: {
                enumerable: true,
                get: () => this.#getOrComputeSeenVectors().firstSeen
            },
            lastSeen: {
                enumerable: true,
                get: () => this.#getOrComputeSeenVectors().lastSeen
            }
        });
    }

    #getOrComputeSeenVectors() {
        let seenVectors = this.#seenVectors?.deref();

        if (seenVectors !== undefined) {
            return seenVectors;
        }

        const { tree, sampleToNode, cumulative, samples } = this;
        const { /* dictionary,*/ nodes, parent } = tree;
        const firstSeen = new Uint32Array(nodes.length).fill(0xffffffff);
        const lastSeen = new Uint32Array(nodes.length);
        // const firstSeenDict = new Uint32Array(dictionary.length).fill(0xffffffff);
        // const lastSeenDict = new Uint32Array(dictionary.length);

        for (let i = 0; i < samples.length; i++) {
            const nodeId = sampleToNode[samples[i]];
            const position = cumulative[i];

            if (firstSeen[nodeId] > position) {
                firstSeen[nodeId] = position;
            }

            if (lastSeen[nodeId] < position) {
                lastSeen[nodeId] = position;
            }
        }

        for (let i = nodes.length - 1; i > 0; i--) {
            const parentId = parent[i];
            // const dictId = nodes[i];
            const fs = firstSeen[i];
            const ls = lastSeen[i];

            if (firstSeen[parentId] > fs) {
                firstSeen[parentId] = fs;
            }

            // if (firstSeenDict[dictId] > fs) {
            //     firstSeenDict[dictId] = fs;
            // }

            if (lastSeen[parentId] < ls) {
                lastSeen[parentId] = ls;
            }

            // if (lastSeenDict[dictId] < ls) {
            //     lastSeenDict[dictId] = ls;
            // }
        }

        this.#seenVectors = new WeakRef(seenVectors = { firstSeen, lastSeen });
        return seenVectors;
    }

    get entries() {
        let entries = this.#entries?.deref();

        if (entries === undefined) {
            const { tree, firstSeen, lastSeen } = this;

            this.#entries = new WeakRef(entries = tree.dictionary.map((entry, entryIndex) => ({
                entryIndex,
                entry,
                firstSeen: firstSeen[entryIndex],
                lastSeen: lastSeen[entryIndex]
            })));
        }

        return entries;
    }

    get entriesMap() {
        let map = this.#entriesMap?.deref();
        debugger;

        if (map === undefined) {
            this.#entriesMap = new WeakRef(map = this.entries.reduce(
                (map, element) => map.set(element.entry, element),
                new Map()
            ));
        }

        return map;
    }
}
