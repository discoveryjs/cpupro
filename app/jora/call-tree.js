import { CallTree } from '../prepare/computations/call-tree.js';
import { TreeMetrics } from '../prepare/computations/metrics.js';
import { getProfileOrScopeProfile } from './profile.js';

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

export function makeSamplesMask(treeMetrics, test) {
    const { tree, sampleToNode } = treeMetrics;
    const { dictionary, nodes } = tree;
    const accept = typeof test === 'function' ? test : (entry) => entry === test;
    const mask = new Uint8Array(sampleToNode.length);

    for (let i = 0; i < mask.length; i++) {
        const nodeIndex = sampleToNode[i];

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

        if (tree instanceof TreeMetrics) {
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
                        const selfValue = treeTimings.selfValues[node.nodeIndex];
                        const nestedValue = treeTimings.nestedValues[node.nodeIndex];

                        result.push({
                            node,
                            selfValue,
                            nestedValue,
                            totalValue: selfValue + nestedValue
                        });
                    }

                    return result;
                }

                return [...tree.map(iterator)];
            }
        }
    },
    // TODO: optimize
    subtreeSamples(treeMetrics, subject, includeSelf = false) {
        const { tree, sampleToNode } = treeMetrics;
        const sampleIds = new Set(sampleToNode);
        const selected = new Set();
        const selectedEntries = new Set();
        const selectedSamples = new Set();
        const mask = new Uint8Array(sampleToNode.length);
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

        for (let i = 0; i < mask.length; i++) {
            if (selected.has(sampleToNode[i])) {
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

    getMetrics(treeTimings, subject) {
        if (typeof subject !== 'number') {
            subject = treeTimings.tree.dictionary.indexOf(subject);
        }

        return treeTimings.getMetrics(subject);
    },

    getValueMetrics(treeTimings, value) {
        return treeTimings.getValueMetrics(value);
    },

    nestedValues(treeMetrics, subject, structureTree) {
        const tree = structureTree || treeMetrics.tree;
        const selfId = typeof subject === 'number' ? subject : tree.dictionary.indexOf(subject);
        const dictMetrics = new Uint32Array(tree.dictionary.length);
        const nodes = tree.nodes;
        const sampleToNode = treeMetrics.sampleToNode;
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

        for (let i = 0; i < sampleToNode.length; i++) {
            if (nodesMask[sampleToNode[i]]) {
                const nodeIndex = sampleToNode[i];

                if (!visited.has(nodeIndex)) {
                    dictMetrics[tree.nodes[nodeIndex]] += treeMetrics.selfValues[nodeIndex];
                    visited.add(nodeIndex);
                }
            }
        }

        for (let i = 0; i < dictMetrics.length; i++) {
            if (dictMetrics[i] > 0) {
                result.push({
                    entry: tree.dictionary[i],
                    selfValue: dictMetrics[i]
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

    bounds(entry, type, profile) {
        const { tree } = getProfileOrScopeProfile(profile, this.context)?.timeline;
        let map;

        switch (type) {
            case 'call-frame': map = tree.callFrames.bounds.entriesMap; break;
            case 'module':     map = tree.modules.bounds.entriesMap; break;
            case 'package':    map = tree.packages.bounds.entriesMap; break;
            case 'category':   map = tree.categories.bounds.entriesMap; break;
        }

        if (map) {
            return map.get(entry);
        }
    }
};
