import { CallTree } from '../prepare/computations/call-tree.js';
import { TreeTimings } from '../prepare/computations/timings.js';

export function makeDictMask(tree, test) {
    const { dictionary } = tree;
    const accept = typeof test === 'function' ? test : (entry) => entry === test;
    const mask = new Uint8Array(dictionary.length);

    for (let i = 0; i < mask.length; i++) {
        if (accept(dictionary[i])) {
            mask[i] = 1;
        }
    }

    return mask;
}

export function makeSamplesMask(tree, test) {
    const { dictionary, sampleIdToNode, nodes } = tree;
    const accept = typeof test === 'function' ? test : (entry) => entry === test;
    const mask = new Uint8Array(sampleIdToNode.length);

    for (let i = 0; i < mask.length; i++) {
        const nodeIndex = sampleIdToNode[i];

        if (accept(dictionary[nodes[nodeIndex]], i)) {
            mask[i] = 1;
        }
    }

    return mask;
}

export const methods = {
    tree(value, getParentIndex, buildValue = node => node) {
        const leafs = value.map(value => ({ parent: null, value, children: [] }));
        const root = { value: null, children: [] };

        for (const leaf of leafs) {
            const parentIndex = getParentIndex(leaf.value);
            const parent = Number.isInteger(parentIndex) && parentIndex >= 0 && parentIndex < leafs.length
                ? leafs[parentIndex]
                : root;

            parent.children.push(leaf);
            leaf.parent = parent !== root ? parent : null;
            leaf.value = buildValue(leaf.value);
        }

        return root.children;
    },

    select(tree, type, ...args) {
        let treeTimings = null;

        if (tree instanceof TreeTimings) {
            treeTimings = tree;
            tree = tree.tree;
        }

        if (tree instanceof CallTree) {
            let iterator;

            switch (type) {
                case 'nodes':
                    iterator = typeof args[0] === 'function'
                        ? tree.selectBy(...args)
                        : tree.selectNodes(...args);
                    break;
                case 'children':
                    iterator = tree.children(...args);
                    break;
                case 'subtree':
                    iterator = tree.subtree(...args);
                    break;
                case 'parent':
                    iterator = tree.ancestors(args[0], 1);
                    break;
                case 'ancestors':
                    iterator = tree.ancestors(...args);
                    break;
            }

            if (iterator !== undefined) {
                if (treeTimings) {
                    const result = [];

                    for (const node of tree.map(iterator)) {
                        const selfTime = treeTimings.selfTimes[node.nodeIndex];
                        const nestedTime = treeTimings.nestedTimes[node.nodeIndex];

                        result.push({
                            node,
                            selfTime,
                            nestedTime,
                            totalTime: selfTime + nestedTime
                        });
                    }

                    return result;
                }

                return [...tree.map(iterator)];
            }
        }
    },
    // TODO: optimize
    subtreeSamples(tree, subject, includeSelf = false) {
        const sampleIdToNode = tree.sampleIdToNode;
        const sampleIds = new Set(sampleIdToNode);
        const selected = new Set();
        const selectedEntries = new Set();
        const selectedSamples = new Set();
        const mask = new Uint8Array(sampleIdToNode.length);
        const selfId = typeof subject === 'number' ? subject : tree.dictionary.indexOf(subject);

        for (const nodeIndex of tree.selectNodes(subject)) {
            if (includeSelf && sampleIds.has(nodeIndex)) {
                selected.add(nodeIndex);
            }

            for (const subtreeNodeIndex of tree.subtree(nodeIndex)) {
                if (sampleIds.has(subtreeNodeIndex) && (includeSelf || tree.nodes[subtreeNodeIndex] !== selfId)) {
                    selected.add(subtreeNodeIndex);
                    selectedEntries.add(tree.dictionary[tree.nodes[subtreeNodeIndex]]);
                }
            }
        }

        for (let i = 0; i < sampleIdToNode.length; i++) {
            if (selected.has(sampleIdToNode[i])) {
                mask[i] = 1;
                selectedSamples.add(i);
            }
        }

        return {
            entries: [...selectedEntries],
            selectedSamples,
            mask,
            sampleSelector: (_, sampleIndex) => selectedSamples.has(sampleIndex)
        };
    },

    getTimings(treeTimings, subject) {
        if (typeof subject !== 'number') {
            subject = treeTimings.tree.dictionary.indexOf(subject);
        }

        return treeTimings.getTimings(subject);
    },

    getValueTimings(treeTimings, value) {
        return treeTimings.getValueTimings(value);
    },

    nestedTimings(treeTimings, subject, structureTree) {
        const timingsTree = treeTimings.tree;
        const tree = structureTree || timingsTree;
        const selfId = typeof subject === 'number' ? subject : tree.dictionary.indexOf(subject);
        const dictTimings = new Uint32Array(timingsTree.dictionary.length);
        const nodes = tree.nodes;
        const sampleIdToNode = tree.sampleIdToNode;
        const nodesMask = new Uint32Array(tree.nodes.length);
        const visited = new Set();
        const result = [];

        for (const nodeIndex of tree.selectNodes(selfId)) {
            for (const subtreeNodeIndex of tree.subtree(nodeIndex)) {
                if (nodes[subtreeNodeIndex] !== selfId) {
                    nodesMask[subtreeNodeIndex] = 1;
                }
            }
        }

        for (let i = 0; i < sampleIdToNode.length; i++) {
            if (nodesMask[sampleIdToNode[i]]) {
                const nodeIndex = timingsTree.sampleIdToNode[i];

                if (!visited.has(nodeIndex)) {
                    dictTimings[timingsTree.nodes[nodeIndex]] += treeTimings.selfTimes[nodeIndex];
                    visited.add(nodeIndex);
                }
            }
        }

        for (let i = 0; i < dictTimings.length; i++) {
            if (dictTimings[i] > 0) {
                result.push({
                    entry: timingsTree.dictionary[i],
                    selfTime: dictTimings[i]
                });
            }
        }

        return result;
    },

    selectBy(tree, test) {
        const { nodes } = tree;
        const mask = makeDictMask(tree, test);
        const result = [];

        for (let i = 0; i < nodes.length; i++) {
            if (mask[nodes[i]]) {
                result.push(tree.getEntry(i));
            }
        }

        return result;
    },

    timestamps(entry, type, profile = this.context.currentProfile) {
        let map;

        switch (type) {
            case 'call-frame': map = profile?.callFramesTreeTimestamps.entriesMap; break;
            case 'module':     map = profile?.modulesTreeTimestamps.entriesMap; break;
            case 'package':    map = profile?.packagesTreeTimestamps.entriesMap; break;
            case 'category':   map = profile?.categoriesTreeTimestamps.entriesMap; break;
        }

        if (map) {
            return map.get(entry);
        }
    }
};
