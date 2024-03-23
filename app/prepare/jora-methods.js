import { typeColor, typeColorComponents, typeOrder } from './const.js';
import { formatMicrosecondsTime } from './time-utils.js';
import { CallTree } from './call-tree.js';
import { TreeTiminigs } from './process-samples.js';

function makeDictMask(tree, test) {
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

function makeSamplesMask(tree, test) {
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

function makeSampleBins(n, mask, samples, timeDeltas, totalTime) {
    const bins = new Float64Array(n);
    const step = totalTime / n;
    let end = step;
    let binIdx = 0;

    for (let i = 0, offset = 0; i < samples.length; i++) {
        const accept = mask[samples[i]];
        const delta = timeDeltas[i];

        if (offset + delta < end) {
            if (accept) {
                bins[binIdx] += delta;
            }
        } else {
            if (accept) {
                const dx = end - offset;
                let x = delta - dx;
                let i = 1;
                while (x > step) {
                    bins[binIdx + i] = step;
                    i++;
                    x -= step;
                }

                bins[binIdx] += dx;
                bins[binIdx + i] = x;
            }

            while (offset + delta > end) {
                binIdx += 1;
                end += step;
            }
        }

        offset += delta;
    }

    return bins;
}

function countSamples(n, samples, timeDeltas, totalTime) {
    const bins = new Uint32Array(n);
    const step = totalTime / n;
    let end = step;
    let binIdx = 0;

    for (let i = 0, offset = 0; i < samples.length; i++) {
        const delta = timeDeltas[i];

        if (offset + delta < end) {
            bins[binIdx]++;
        } else {
            const dx = end - offset;
            let x = delta - dx;
            let i = 1;
            while (x > step) {
                bins[binIdx + i]++;
                i++;
                x -= step;
            }

            bins[binIdx]++;
            bins[binIdx + i]++;

            while (offset + delta > end) {
                binIdx += 1;
                end += step;
            }
        }

        offset += delta;
    }

    return Array.from(bins); // TODO: remove when jora has support for TypedArrays
}

export default {
    order(value) {
        return typeOrder[value] || 100;
    },
    color(value, comp) {
        const dict = comp ? typeColorComponents : typeColor;
        return dict[value] || dict.unknown;
    },
    totalPercent(value, prec = 2) {
        const totalTime = (this.context.context || this.context)?.data?.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        const min = 1 / Math.pow(10, prec || 1);
        return percent >= min ? percent.toFixed(prec || 1) + '%' : percent !== 0 ? '<' + min + '%' : '0%';
    },
    duration(value) {
        const totalTime = (this.context.context || this.context)?.data?.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        return (value / 1000).toFixed(1) + 'ms' + (percent >= 0.01 ? ' / ' + percent.toFixed(2) + '%' : '');
    },
    ms(value) {
        return (value / 1000).toFixed(1) + 'ms';
    },
    formatMicrosecondsTime,
    select(tree, type, ...args) {
        let treeTimings = null;

        if (tree instanceof TreeTiminigs) {
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
    binCallsFromMask(mask, n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;
        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        return Array.from(bins);
    },
    nestedTimings(tree, subject, treeTimings2) {
        const tree2 = treeTimings2.tree;
        const sampleIdToNode = tree.sampleIdToNode;
        const sampleIds = new Set(sampleIdToNode);
        const selected = new Set();
        const visited = new Set();
        const tree2dict = new Uint32Array(tree2.dictionary.length);
        const selfId = typeof subject === 'number' ? subject : tree.dictionary.indexOf(subject);
        const result = [];

        for (const nodeIndex of tree.selectNodes(subject)) {
            for (const subtreeNodeIndex of tree.subtree(nodeIndex)) {
                if (sampleIds.has(subtreeNodeIndex) && tree.nodes[subtreeNodeIndex] !== selfId) {
                    selected.add(subtreeNodeIndex);
                }
            }
        }

        for (let i = 0; i < sampleIdToNode.length; i++) {
            if (selected.has(sampleIdToNode[i])) {
                const nodeIndex = tree2.sampleIdToNode[i];

                if (!visited.has(nodeIndex)) {
                    tree2dict[tree2.nodes[nodeIndex]] += treeTimings2.selfTimes[nodeIndex];
                    visited.add(nodeIndex);
                }
            }
        }

        for (let i = 0; i < tree2.dictionary.length; i++) {
            if (tree2dict[i] > 0) {
                result.push({
                    entry: tree2.dictionary[i],
                    selfTime: tree2dict[i]
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
    countSamples(n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;

        return countSamples(n, samples, timeDeltas, totalTime);
    },
    binCalls(tree, test, n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;
        const mask = makeSamplesMask(tree, test);
        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        // let sum = 0;
        // for (let i = 0; i < bins.length; i++) {
        //     sum += bins[i];
        //     // bins[i] /= step;
        // }
        // bins[0] = step;

        return Array.from(bins); // TODO: remove when jora has support for TypedArrays
    }
};
