import { ProfileLine, ProfileLineType, ProfileLineAttribute, type LineTreeDimension } from '../prepare/lines/types.js';
import type { CpuProNode } from '../prepare/types.js';
import { resolveScopeProfileLine, resolveScopeProfileLineBreakdown, resolveScopeViewport } from './profile.js';
import { binningRange } from './viewport.js';
import { findCumulativeBoundary, type Population, type PopulationFiltered } from '../prepare/computations/population.js';

export function sampleRange(cumulative: Float64Array, total: number, skip: number, sourceTotal: number) {
    const start = Math.max(0, -skip);
    const end = Math.min(sourceTotal, total - skip);

    if (start >= end) {
        return {
            first: 0,
            last: -1,
            offset: 0,
            startCut: 0,
            endCut: 0
        };
    }

    const first = Math.max(0, findCumulativeBoundary(cumulative, start, true) - 1);
    const last = findCumulativeBoundary(cumulative, end, false) - 1;
    const lastEnd = last + 1 < cumulative.length ? cumulative[last + 1] : sourceTotal;

    return {
        first,
        last,
        offset: start + skip,
        startCut: start - cumulative[first],
        endCut: lastEnd - end
    };
}

function countSamples(n: number, viewport: PopulationFiltered, total: number, continues: boolean, skip: number) {
    const bins = new Uint32Array(n);
    const step = total / n;
    const { population, samples, values, sinkId } = viewport;
    const { values: originalValues, cumulative, cumulativeEnd } = population;
    let previousEvent = -1;
    let previousBin = -1;

    for (const range of viewport.ranges ?? [{ start: 0, end: cumulativeEnd }]) {
        const start = Math.max(0, range.start + skip);
        const end = Math.min(total, range.end + skip);

        if (start >= end) {
            continue;
        }

        const { first, last, offset, startCut } = sampleRange(cumulative, end - start, skip - start, cumulativeEnd);
        let position = offset + start - startCut;
        let binIndex = Math.floor((offset + start) / step);
        let binEnd = (binIndex + 1) * step;
        let count = 0;

        if (continues) {
            const lastBin = Math.min(n - 1, Math.ceil(end / step) - 1);

            if (first === previousEvent && binIndex <= previousBin) {
                count = -1;
            }

            for (let index = first; index <= last; index++) {
                const accepted = samples[index] !== sinkId && values[index] > 0;

                if (accepted) {
                    count++;
                }

                position += originalValues[index];

                if (position >= binEnd) {
                    const nextBin = Math.floor(position / step);

                    bins[binIndex] += count;
                    count = 0;

                    if (accepted) {
                        const finish = Math.min(lastBin, position === nextBin * step ? nextBin - 1 : nextBin);

                        for (let crossedBin = binIndex + 1; crossedBin <= finish; crossedBin++) {
                            bins[crossedBin]++;
                        }
                    }

                    binIndex = nextBin;
                    binEnd = (binIndex + 1) * step;
                }
            }

            previousEvent = last >= first && samples[last] !== sinkId && values[last] > 0 ? last : -1;
            previousBin = Math.min(lastBin, Math.ceil(position / step) - 1);
        } else {
            const firstIndex = startCut > 0 ? first + 1 : first;

            position = cumulative[firstIndex] + skip;

            for (let index = firstIndex; index <= last; index++) {
                if (position >= binEnd) {
                    bins[binIndex] += count;
                    count = 0;
                    binIndex = Math.floor(position / step);
                    binEnd = (binIndex + 1) * step;
                }

                if (samples[index] !== sinkId && values[index] > 0) {
                    count++;
                }

                position += originalValues[index];
            }
        }

        bins[binIndex] += count;
    }

    return bins;
}

export const methods = {
    attributeSampleTotals(attribute: ProfileLineAttribute, population: Population | PopulationFiltered) {
        const { values, dict } = attribute;
        const { samplesCount, samplesTotal } = population.aggregateBy(values, dict.length);

        return dict.map((entry, index) => ({ entry, count: samplesCount[index], size: samplesTotal[index] }));
    },
    // Self values of a breakdown's entries (e.g. categories) in a population, by the samples of their nodes
    dimensionSampleTotals(dimension: LineTreeDimension<CpuProNode>, population: PopulationFiltered) {
        const { tree, sampleToNode } = dimension;
        const { samplesCount, samplesTotal } = population;
        const counts = new Uint32Array(tree.dictionary.length);
        const totals = new Float64Array(tree.dictionary.length);

        for (let sample = 0; sample < samplesCount.length; sample++) {
            if (samplesCount[sample] > 0) {
                const entry = tree.nodes[sampleToNode[sample]];

                counts[entry] += samplesCount[sample];
                totals[entry] += samplesTotal[sample];
            }
        }

        return tree.dictionary.map((entry, index) => ({ entry, count: counts[index], value: totals[index] }));
    },
    // Numbers of a breakdown's tree nodes and entries with samples in a population: the nodes of the samples
    // and their ancestors
    dimensionPresence(dimension: LineTreeDimension<CpuProNode>, population: PopulationFiltered) {
        const { tree, sampleToNode } = dimension;
        const { nodes, parent } = tree;
        const { samplesCount } = population;
        const presentNodes = new Uint8Array(nodes.length);
        const presentEntries = new Uint8Array(tree.dictionary.length);
        let nodeCount = 0;
        let entryCount = 0;

        for (let sample = 0; sample < samplesCount.length; sample++) {
            if (samplesCount[sample] > 0) {
                presentNodes[sampleToNode[sample]] = 1;
            }
        }

        // Parents precede their children, so a node is marked by its descendants before it's visited
        for (let node = nodes.length - 1; node >= 0; node--) {
            if (presentNodes[node] === 1) {
                const entry = nodes[node];

                nodeCount++;
                presentNodes[parent[node]] = 1;

                if (presentEntries[entry] === 0) {
                    presentEntries[entry] = 1;
                    entryCount++;
                }
            }
        }

        return { nodes: nodeCount, entries: entryCount };
    },
    countSamples(n = 500, line?: ProfileLine | ProfileLineType) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);
        const breakdown = resolveScopeProfileLineBreakdown(null, resolvedLine, this.context)!;

        return countSamples(n, breakdown.populationWindow, total, true, skip);
    },

    countSamplesDiscrete(n = 500, line: unknown) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);
        const breakdown = resolveScopeProfileLineBreakdown(null, resolvedLine, this.context)!;

        return countSamples(n, breakdown.populationWindow, total, false, skip);
    },

    sampleXBins(n = 500, line?: ProfileLine | ProfileLineType) {
        const { values } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const max = 1500; // Math.min(timeDeltas.reduce((m, i) => i > m ? i : m, 0), 2000);
        const step = max / n;
        const bins = new Uint32Array(n);

        for (const d of values) {
            const x = Math.min(Math.floor(d / step), n - 1);
            bins[x]++;
        }

        return {
            max,
            bins
        };
    }
};
