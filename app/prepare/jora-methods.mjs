import { typeColor, typeColorComponents, typeOrder, vmFunctionStateTiers } from './const.js';
import { formatMicrosecondsTime } from './time-utils.js';
import { CallTree } from './computations/call-tree.js';
import { TreeTimings } from './computations/timings.js';

const abbr = {
    Ignition: 'Ig',
    Sparkplug: 'Sp',
    Maglev: 'Mg',
    Turboprop: 'Tp',
    Turbofan: 'Tb',
    Unknown: '??'
};

function shortNum(current, units, base = 1000) {
    let unitIdx = 0;

    while (current > base && unitIdx < units.length - 1) {
        current /= base;
        unitIdx++;
    }

    const value = unitIdx === 0
        ? current
        : current < 100
            ? current.toFixed(1).replace(/\.0/, '')
            : Math.round(current);

    return value + units[unitIdx];
}

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

const methods = {
    order(value) {
        return typeOrder[value] || 100;
    },
    color(value, comp) {
        const dict = comp ? typeColorComponents : typeColor;
        return dict[value] || dict.unknown;
    },
    abbr(value) {
        return abbr[value] || value;
    },
    toFixed(value, prec = 2) {
        return Number(value).toFixed(prec);
    },
    percent(value, prec = 2) {
        return (100 * value).toFixed(prec) + '%';
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
    bytes(current, bytes = true) {
        return shortNum(current, [bytes ? 'bytes' : '', 'Kb', 'Mb', 'Gb'], 1024);
    },
    shortNum(current) {
        return shortNum(current, ['', 'K', 'M', 'G']);
    },
    formatMicrosecondsTime,
    zip(left, leftValue = value => value, right, rightValue = value => value) {
        const map = new Map(left.map(element => [leftValue(element), { left: element, right: null }]));

        for (const element of right) {
            const entry = map.get(rightValue(element));

            if (entry !== undefined) {
                entry.right = element;
            }
        }

        return [...map.values()];
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
    binCallsFromMask(mask, n = 500, profile = this.context.currentProfile) {
        const { samples, timeDeltas, totalTime } = profile;
        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        return Array.from(bins);
    },
    getTimings(treeTimings, subject) {
        if (typeof subject !== 'number') {
            subject = treeTimings.tree.dictionary.indexOf(subject);
        }

        return treeTimings.getTimings(subject);
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
    countSamples(n = 500, profile = this.context.currentProfile) {
        const { samples, timeDeltas, totalTime } = profile;

        return countSamples(n, samples, timeDeltas, totalTime);
    },
    binCalls(tree, test, n = 500, profile = this.context.currentProfile) {
        const { samples, timeDeltas, totalTime } = profile;
        const mask = makeSamplesMask(tree, test);
        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        // let sum = 0;
        // for (let i = 0; i < bins.length; i++) {
        //     sum += bins[i];
        //     // bins[i] /= step;
        // }
        // bins[0] = step;

        return Array.from(bins); // TODO: remove when jora has support for TypedArrays
    },
    binMemory(heapEvents, eventFilter = 'new', n = 500, profile = this.context.currentProfile) {
        const { totalTime } = profile;
        const bins = new Float64Array(n);
        const step = totalTime / n;
        let end = step;
        let binIdx = 0;

        for (let i = 0; i < heapEvents.length; i++) {
            const { tm, event, size } = heapEvents[i];

            if (tm === 0 || event !== eventFilter) {
                continue;
            }

            while (tm > end) {
                binIdx++;
                end += step;
            }

            bins[binIdx] += size;
        }

        return bins;
    },
    binMemoryTotal(heapEvents, n = 500, profile = this.context.currentProfile) {
        const { totalTime } = profile;
        const bins = new Float64Array(n);
        const step = totalTime / n;
        let end = step;
        let binIdx = 0;

        for (let i = 0; i < heapEvents.length; i++) {
            const { tm, event, size } = heapEvents[i];

            if (tm === 0) {
                continue;
            }

            while (tm > end) {
                binIdx++;
                bins[binIdx] = bins[binIdx - 1];
                end += step;
            }

            bins[binIdx] += event === 'new' ? size : -size;
        }

        if (binIdx < n - 1) {
            bins.fill(bins[binIdx], binIdx + 1);
        }

        return bins;
    },
    binScriptFunctionCodes(functionCodes, n = 500, profile = this.context.currentProfile) {
        const { totalTime } = profile;
        const bins = new Uint32Array(n);
        const step = totalTime / n;
        let end = step;
        let binIdx = 0;

        for (let i = 0; i < functionCodes.length; i++) {
            const { tm } = functionCodes[i];

            while (tm > end) {
                binIdx++;
                end += step;
            }

            bins[binIdx] += 1;
        }

        if (binIdx < n - 1) {
            bins.fill(bins[binIdx], binIdx + 1);
        }

        return bins;
    },
    binScriptFunctionCodesTotal(functionCodes, n = 500, profile = this.context.currentProfile) {
        const { totalTime } = profile;
        const step = totalTime / n;
        const binByTier = new Map();
        const fnTier = new Map();
        const fnCount = new Uint32Array(n);
        let end = step;
        let binIdx = 0;

        for (const tier of vmFunctionStateTiers) {
            binByTier.set(tier, new Uint32Array(n));
        }

        for (let i = 0; i < functionCodes.length; i++) {
            const { tm, tier, callFrameCodes } = functionCodes[i];

            while (tm > end) {
                binIdx++;
                fnCount[binIdx] = fnCount[binIdx - 1];
                for (let bins of binByTier.values()) {
                    bins[binIdx] = bins[binIdx - 1];
                }
                end += step;
            }

            const currentTier = fnTier.get(callFrameCodes);
            if (currentTier === undefined) {
                // new function
                binByTier.get(tier)[binIdx]++;
                fnCount[binIdx]++;
            } else if (tier !== currentTier) {
                // maybe change function tier
                binByTier.get(currentTier)[binIdx]--;
                binByTier.get(tier)[binIdx]++;
            }

            fnTier.set(callFrameCodes, tier);
        }

        if (binIdx < n - 1) {
            fnCount.fill(fnCount[binIdx], binIdx + 1);
            for (let bins of binByTier.values()) {
                bins.fill(bins[binIdx], binIdx + 1);
            }
        }

        return { byTier: [...binByTier.entries()], fnCount: fnCount };
    }
};

export default methods;

// import { trackExecutionTime } from './jora-methods-bench.js';
// TIMINGS && trackExecutionTime(methods, ['select', 'selectBy', 'subtreeSamples', 'nestedTimings', 'binCalls']);
