import { typeColor, typeColorComponents, typeOrder } from './const.js';
import { formatMicrosecondsTime } from './time-utils.js';
import { CallTree } from './call-tree.js';

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
    totalPercent(value) {
        const totalTime = (this.context.context || this.context)?.data?.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        return percent >= 0.1 ? percent.toFixed(2) + '%' : percent !== 0 ? '<0.1%' : '0%';
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
        if (tree instanceof CallTree) {
            let iterator;

            switch (type) {
                case 'nodes':
                    iterator = tree.selectNodes(...args);
                    break;
                case 'children':
                    iterator = tree.children(...args);
                    break;
                case 'subtree':
                    iterator = tree.subtree(...args);
                    break;
                case 'ancestors':
                    iterator = tree.ancestors(...args);
                    break;
            }

            if (iterator !== undefined) {
                return [...tree.map(iterator)];
            }
        }
    },
    // TODO: optimize
    subtreeSamples(tree, subject, includeSelf = false) {
        const mapToIndex = tree.mapToIndex;
        const sampleIds = new Set(mapToIndex);
        const selected = new Set();
        const selectedEntries = new Set();
        const selectedSamples = new Set();
        const mask = new Uint8Array(mapToIndex.length);
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

        for (let i = 0; i < mapToIndex.length; i++) {
            if (selected.has(mapToIndex[i])) {
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
    nestedTimings(tree, subject, tree2 = tree) {
        const mapToIndex = tree.mapToIndex;
        const sampleIds = new Set(mapToIndex);
        const selected = new Set();
        const visited = new Set();
        const tree2dict = new Uint32Array(tree2.dictionary.length);
        const result = [];
        const selfId = typeof subject === 'number' ? subject : tree.dictionary.indexOf(subject);

        for (const nodeIndex of tree.selectNodes(subject)) {
            for (const subtreeNodeIndex of tree.subtree(nodeIndex)) {
                if (sampleIds.has(subtreeNodeIndex) && tree.nodes[subtreeNodeIndex] !== selfId) {
                    selected.add(subtreeNodeIndex);
                }
            }
        }

        for (let i = 0; i < mapToIndex.length; i++) {
            if (selected.has(mapToIndex[i])) {
                const nodeIndex = tree2.mapToIndex[i];

                if (!visited.has(nodeIndex)) {
                    tree2dict[tree2.nodes[nodeIndex]] += tree2.selfTimes[nodeIndex];
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
    countSamples(n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;

        return countSamples(n, samples, timeDeltas, totalTime);
    },
    binCalls(tree, test, n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;
        const { dictionary, nodes, mapToIndex } = tree;
        const acceptFn = typeof test === 'function' ? test : (entry) => entry === test;
        const mask = new Uint8Array(mapToIndex.length);

        for (let i = 0; i < mask.length; i++) {
            const nodeIndex = mapToIndex[i];
            const accept = acceptFn(dictionary[nodes[nodeIndex]], i);

            if (accept) {
                mask[i] = 1;
            }
        }

        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        // let sum = 0;
        // for (let i = 0; i < bins.length; i++) {
        //     sum += bins[i];
        //     // bins[i] /= step;
        // }
        // bins[0] = step;

        return bins;

        return Array.from(bins); // TODO: remove when jora has support for TypedArrays
    },
    groupByCallSiteRef: `
        group(=>callFrame.ref).({
            grouped: value,
            ...value[],
            children: value.children,
            selfTime: value.sum(=>selfTime),
            totalTime: value | $ + ..children | .sum(=>selfTime),
        })
    `
};
