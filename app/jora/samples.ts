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

// Accepted events per bin of the window's ranges: events intersecting a bin, or starting in it when they don't
// continue across bins. Positions find the events of a bin, the window counts the accepted ones
function countSamples(n: number, viewport: PopulationFiltered, total: number, continues: boolean, skip: number) {
    const bins = new Uint32Array(n);
    const step = total / n;
    const { cumulative, cumulativeEnd } = viewport.population;
    const ranges = viewport.ranges ?? [{ start: 0, end: cumulativeEnd }];

    for (let i = 0; i < n; i++) {
        const events: [number, number][] = [];

        for (let j = 0; j < ranges.length; j++) {
            const start = Math.max(i * step, ranges[j].start + skip);
            const end = Math.min((i + 1) * step, ranges[j].end + skip);

            if (start >= end) {
                continue;
            }

            const { first, last, startCut } = sampleRange(cumulative, end - start, skip - start, cumulativeEnd);
            const firstEvent = continues || startCut === 0 ? first : first + 1;
            const previous = events[events.length - 1];

            // An event at the edges of two ranges in a bin is counted once
            if (previous !== undefined && firstEvent < previous[1]) {
                previous[1] = Math.max(previous[1], last + 1);
            } else if (firstEvent <= last) {
                events.push([firstEvent, last + 1]);
            }
        }

        bins[i] = viewport.countAccepted(events);
    }

    return bins;
}

export const methods = {
    attributeSampleTotals(attribute: ProfileLineAttribute, population: Population | PopulationFiltered) {
        const { values, dict } = attribute;
        const { samplesCount, samplesTotal } = population.aggregateBy(values, dict.length);

        return dict.map((entry, index) => ({ entry, count: samplesCount[index], size: samplesTotal[index] }));
    },
    // Events of a population accepted within its ranges, including zero-weight events at positions in the ranges
    populationEventCount(population: PopulationFiltered) {
        const { samplesCount, ranges, sinkId } = population;
        const { zeroEvents, cumulative, cumulativeEnd } = population.population;
        // Ranges are half-open, but events at the end of the axis are within a range reaching it
        const endOf = (range: { end: number }) => range.end >= cumulativeEnd ? Infinity : range.end;
        let count = 0;

        for (let sample = 0; sample < samplesCount.length; sample++) {
            count += samplesCount[sample];
        }

        if (zeroEvents.length > 0) {
            const { destination } = population.eventReader();
            let rangeIndex = 0;

            for (const event of zeroEvents) {
                const position = cumulative[event];

                while (ranges !== null && rangeIndex < ranges.length && endOf(ranges[rangeIndex]) <= position) {
                    rangeIndex++;
                }

                const inRanges = ranges === null || (rangeIndex < ranges.length && ranges[rangeIndex].start <= position);

                if (inRanges && destination(event) !== sinkId) {
                    count++;
                }
            }
        }

        return count;
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
