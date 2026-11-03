import { typeColor, vmFunctionStateTiers } from '../prepare/const.js';
import { ProfileLine, ProfileLineAttribute, ProfileLineBreakdown, ProfileLineType } from '../prepare/lines/types.js';
import { sum } from '../prepare/misc/utils.js';
import { Profile } from '../prepare/profile.mjs';
import { CpuProCallFrameCode, V8CallFrameCodeType, V8HeapEvent } from '../prepare/types.js';
import { makeSamplesMask } from './call-tree.js';
import { sampleRange } from './samples.js';
import { getProfileOrScopeProfile, resolveScopeProfileLine, resolveScopeProfileLineBreakdown, resolveScopeViewport } from './profile.js';
import { binningRange, rangeBins, timestampExtent } from './viewport.js';
import { isRange, type Range } from '../prepare/computations/coordinates.js';
import { findCumulativeBoundary, type PopulationFiltered } from '../prepare/computations/population.js';
import type { SampledTree } from '../prepare/computations/metrics.js';

function getCallStackPopulation(line: ProfileLine) {
    return line.breakdowns.find(tree => tree.kind === 'call-stack')!.population;
}

function timestampBins(line: ProfileLine, viewport: Range | null, count: number, lastTime: number, origin = line.axisStart) {
    // Codes are relative to axisStart; V8 heap events retain log timestamps (origin zero).
    // Samples do not define either stream's end. Retain events beyond the sample recording.
    const extent = timestampExtent(line, lastTime, origin);
    const bounds = viewport || extent;

    return {
        ...rangeBins(extent, bounds, count),
        skip: origin - bounds.start,
        start: Math.max(extent.start, bounds.start) - origin,
        end: Math.min(extent.end, bounds.end) - origin
    };
}

function sampleBinStep(total: number, n: number) {
    const realStep = total / n;
    const roundStep = Math.ceil(realStep);

    // If the rounded step leaves a remainder that is less than the step size,
    // that means that the remainer will be located in the last bin,
    // and allow to use the rounded step that moves computations into integer space,
    // which is faster than using floating point numbers.
    return roundStep * n - total < roundStep
        ? roundStep
        : realStep;
}

function makeSampleBins(
    n: number,
    mask: Uint8Array,
    viewport: PopulationFiltered,
    total: number,
    skip = 0,
    range: Range = { start: 0, end: total }
) {
    const { samples, values: acceptedValues, population, sinkId } = viewport;
    const { values, cumulative, cumulativeEnd } = population;
    const bins = new Float64Array(n);
    const rems = new Float64Array(n);
    const step = sampleBinStep(total, n);
    const { first, last, offset: localStart, startCut, endCut } = sampleRange(cumulative, range.end - range.start, skip - range.start, cumulativeEnd);
    const start = localStart + range.start;
    const lastBin = Math.min(n - 1, Math.ceil(range.end / step) - 1);
    const firstSampleId = samples[first];
    const lastSampleId = samples[last];
    let binIdx = Math.floor(start / step) | 0;
    let end = (binIdx + 1) * step;
    let offset = start - startCut;
    let acc = startCut > 0 && firstSampleId !== sinkId && mask[firstSampleId] && acceptedValues[first] > 0
        ? -startCut
        : 0;

    // PERF: Two pass implementation of binning samples into bins, with remainders applied to the next bin
    // allow to keep the main loop simpler (without inner loops) and faster,
    // while still keeping the same time complexity of O(n).
    for (let i = first; i <= last; i++) {
        const sampleId = samples[i];
        const accept = sampleId !== sinkId && mask[sampleId] && acceptedValues[i] > 0;
        const delta = values[i];

        offset += delta;

        if (accept) {
            acc += delta;
        }

        // if offset exceeds the end of the current bin, we need to move to the next bin
        if (offset >= end) {
            bins[binIdx] = acc;

            if (accept) {
                bins[binIdx] -= offset - end;
                rems[binIdx] = offset - end;
            }

            binIdx = Math.floor(offset / step) | 0;
            end = (binIdx + 1) * step;
            acc = 0;
        }
    }

    bins[binIdx] = acc;

    // apply remainders to bins
    for (let i = 0; i <= lastBin; i++) {
        for (let rem = rems[i], j = i + 1; rem > 0 && j <= lastBin; j++) {
            const delta = Math.min(rem, step);
            bins[j] += delta;
            rem -= delta;
        }
    }

    if (endCut > 0 && lastSampleId !== sinkId && mask[lastSampleId] && acceptedValues[last] > 0) {
        bins[lastBin] -= Math.min(endCut, Math.max(0, (lastBin + 1) * step - range.end));
    }

    return bins;
}

function makeViewportBins(n: number, mask: Uint8Array, viewport: PopulationFiltered, total: number, skip: number) {
    const { ranges } = viewport;

    if (ranges === null) {
        return makeSampleBins(n, mask, viewport, total, skip);
    }

    const bins = new Float64Array(n);

    for (const range of ranges) {
        const start = Math.max(0, range.start + skip);
        const end = Math.min(total, range.end + skip);

        if (start < end) {
            const part = makeSampleBins(n, mask, viewport, total, skip, { start, end });

            for (let index = 0; index < n; index++) {
                bins[index] += part[index];
            }
        }
    }

    return bins;
}

type BinTrack = {
    bins: Uint32Array | Float64Array;
    value: number;
};

type BinGrid = {
    total: number;
    step: number;
    skip: number;
};

// PERF: Keeping this loop out of the coordinator removes its repeated OSR exits in Node 26 (V8 14.6).
function addBins(target: Uint32Array, source: Uint32Array | Float64Array) {
    for (let index = 0; index < target.length; index++) {
        target[index] += source[index];
    }
}

// PERF: Full events in one bin need no crossing test; retain per-event stores and addition order.
function binPopulationBin(
    samples: Uint32Array,
    values: Uint32Array,
    acceptedValues: Uint32Array,
    sinkId: number,
    tracks: BinTrack[],
    groups: Uint8Array | Uint32Array | null,
    first: number,
    last: number,
    binIndex: number,
    binValue: number
) {
    for (let index = first; index < last; index++) {
        const value = values[index];

        if (samples[index] !== sinkId && acceptedValues[index] > 0) {
            const groupIndex = groups ? groups[index] : 0;
            const track = tracks[groupIndex];

            track.value += value;
            track.bins[binIndex] += value;
        }

        binValue += value;
    }

    return binValue;
}

// PERF: Keep coordinate division at range boundaries, not in the occurrence loop.
// V8 14.6 deoptimizes after monomorphic warmup when bin/group element types change;
// benchmark mixed-call transitions as well as isolated throughput before changing this shared path.
function binPopulation(
    viewport: PopulationFiltered,
    tracks: BinTrack[],
    groups: Uint8Array | Uint32Array | null,
    { total, step, skip }: BinGrid
) {
    const { samples, values: acceptedValues, sinkId, ranges, population } = viewport;
    const { values, cumulative, cumulativeEnd } = population;

    const addBoundary = (index: number, startCut: number, endCut: number) => {
        if (samples[index] === sinkId || acceptedValues[index] === 0) {
            return;
        }

        const groupIndex = groups ? groups[index] : 0;
        const track = tracks[groupIndex];
        const offset = cumulative[index] + skip + startCut;
        let binIndex = Math.floor(offset / step);
        let binValue = offset - binIndex * step;
        let value = values[index] - startCut - endCut;

        track.value += value;

        while (binValue + value >= step) {
            const delta = step - binValue;

            track.bins[binIndex++] += delta;
            value -= delta;
            binValue = 0;
        }

        if (value > 0) {
            track.bins[binIndex] += value;
        }
    };

    for (const range of ranges ?? [{ start: 0, end: cumulativeEnd }]) {
        const start = Math.max(0, range.start + skip);
        const end = Math.min(total, range.end + skip);

        if (start >= end) {
            continue;
        }

        const { first, last, startCut, endCut } = sampleRange(cumulative, end - start, skip - start, cumulativeEnd);

        if (first > last) {
            continue;
        }

        addBoundary(first, startCut, first === last ? endCut : 0);

        const offset = cumulative[first] + values[first] + skip;
        let binIndex = Math.floor(offset / step);
        let binValue = offset - binIndex * step;

        for (let index = first + 1; index < last; index++) {
            // IMPORTANT: Round the search down: cumulative coordinates are integers, bin remainders need not be.
            const boundary = Math.floor(cumulative[index] + (step - binValue));
            const stop = Math.min(last, Math.max(index, findCumulativeBoundary(cumulative, boundary, false) - 1));

            binValue = binPopulationBin(samples, values, acceptedValues, sinkId, tracks, groups, index, stop, binIndex, binValue);
            index = stop;

            if (index === last) {
                break;
            }

            const groupIndex = groups ? groups[index] : 0;
            const track = tracks[groupIndex];
            const accept = samples[index] !== sinkId && acceptedValues[index] > 0;
            let value = values[index];

            if (accept) {
                track.value += value;
            }

            while (binValue + value >= step) {
                const delta = step - binValue;

                if (accept) {
                    track.bins[binIndex] += delta;
                }

                value -= delta;
                binValue = 0;
                binIndex++;
            }

            if (accept) {
                track.bins[binIndex] += value;
            }

            binValue += value;
        }

        if (last !== first) {
            addBoundary(last, 0, endCut);
        }
    }
}

function createTargetBinReader(axis: PopulationFiltered, cumulative: Uint32Array, { total, step, skip }: BinGrid) {
    const { samples, values, sinkId, ranges } = axis;
    // IMPORTANT: Targets must be visited in nondecreasing order; this cursor never moves backward.
    let rangeIndex = 0;

    return (target: number) => {
        const coordinate = cumulative[target];
        const position = coordinate + skip;
        const inViewport = position >= 0 && position < total;

        if (!inViewport) {
            return -1;
        }

        if (samples[target] === sinkId || values[target] === 0) {
            return -1;
        }

        if (ranges) {
            while (rangeIndex < ranges.length && ranges[rangeIndex].end <= coordinate) {
                rangeIndex++;
            }

            const range = ranges[rangeIndex];

            if (!range || coordinate < range.start) {
                return -1;
            }
        }

        return Math.floor(position / step);
    };
}

function binMappedPopulation(
    line: ProfileLine,
    viewport: PopulationFiltered,
    tracks: BinTrack[],
    groups: Uint8Array | Uint32Array | null,
    mapping: Uint32Array,
    targetBin: (target: number) => number
) {
    const { values, axisTotal } = line;
    const { samples, values: acceptedValues, sinkId, ranges, cumulative } = viewport;
    let previousTarget = -1;
    let binIndex = -1;
    // IMPORTANT: Disjoint source ranges can cut the same event. Emit their combined value once.
    let boundaryIndex = -1;
    let boundaryValue = 0;

    const flushBoundary = () => {
        if (boundaryIndex !== -1 && samples[boundaryIndex] !== sinkId && acceptedValues[boundaryIndex] > 0) {
            const target = targetBin(mapping[boundaryIndex]);

            if (target !== -1) {
                const groupIndex = groups ? groups[boundaryIndex] : 0;
                const track = tracks[groupIndex];

                track.bins[target] += boundaryValue;
                track.value += boundaryValue;
            }
        }

        boundaryIndex = -1;
        boundaryValue = 0;
    };

    for (const range of ranges ?? [{ start: 0, end: viewport.cumulativeEnd }]) {
        const { first, last, startCut, endCut } = sampleRange(cumulative, range.end - range.start, -range.start, axisTotal);

        if (first > last) {
            continue;
        }

        if (boundaryIndex !== first) {
            flushBoundary();
            boundaryIndex = first;
        }

        boundaryValue += values[first] - startCut - (first === last ? endCut : 0);

        if (first === last) {
            continue;
        }

        flushBoundary();

        for (let index = first + 1; index < last; index++) {
            const target = mapping[index];

            // PERF: Many allocations share one CPU event; resolve its bin once per consecutive run.
            if (target !== previousTarget) {
                previousTarget = target;
                binIndex = targetBin(target);
            }

            if (binIndex !== -1 && samples[index] !== sinkId) {
                const groupIndex = groups ? groups[index] : 0;
                const track = tracks[groupIndex];
                const value = acceptedValues[index];

                track.bins[binIndex] += value;
                track.value += value;
            }
        }

        boundaryIndex = last;
        boundaryValue = values[last] - endCut;
    }

    flushBoundary();
}

function sumMappedValues(viewport: PopulationFiltered, mapping: Uint32Array, acceptedTargets: Uint8Array) {
    const { samples, values, sinkId } = viewport;
    let total = 0;

    for (let i = 0; i < values.length; i++) {
        if (samples[i] !== sinkId && acceptedTargets[mapping[i]]) {
            total += values[i];
        }
    }

    return total;
}

function sumMappedValuesByGroup(
    viewport: PopulationFiltered,
    mapping: Uint32Array,
    acceptedTargets: Uint8Array,
    totals: Float64Array,
    groups: Uint8Array | Uint32Array
) {
    const { samples, values, sinkId } = viewport;

    for (let i = 0; i < values.length; i++) {
        if (samples[i] !== sinkId && acceptedTargets[mapping[i]]) {
            const groupIndex = groups[i];

            totals[groupIndex] += values[i];
        }
    }
}

function createAcceptedTargets(axisCount: number, targetBin: (target: number) => number) {
    // PERF: Acceptance is axis-sized, not allocation-sized. Resolve it once before the larger source scan.
    const acceptedTargets = new Uint8Array(axisCount);
    let acceptedCount = 0;

    for (let index = 0; index < axisCount; index++) {
        acceptedTargets[index] = targetBin(index) === 0 ? 1 : 0;
        acceptedCount += acceptedTargets[index];
    }

    return acceptedCount === 0 ? null : acceptedTargets;
}

function binMappedTotals(
    viewport: PopulationFiltered,
    tracks: BinTrack[],
    groups: Uint8Array | Uint32Array | null,
    mapping: Uint32Array,
    axisCount: number,
    targetBin: (target: number) => number
) {
    const acceptedTargets = createAcceptedTargets(axisCount, targetBin);

    if (acceptedTargets === null) {
        return;
    }

    const totals = new Float64Array(tracks.length);

    if (groups === null) {
        totals[0] = sumMappedValues(viewport, mapping, acceptedTargets);
    } else {
        sumMappedValuesByGroup(viewport, mapping, acceptedTargets, totals, groups);
    }

    for (let index = 0; index < tracks.length; index++) {
        tracks[index].value = totals[index];
        tracks[index].bins[0] = totals[index];
    }
}

// PERF: Full events already carry filtered weights; do not reread Base weights or test them again.
function sumTreeEvents(
    samples: Uint32Array,
    values: Uint32Array,
    sampleToNode: Uint32Array,
    sinkId: number,
    totals: Float64Array,
    start: number,
    end: number
) {
    for (let index = start; index < end; index++) {
        const sample = samples[index];

        if (sample !== sinkId) {
            totals[sampleToNode[sample]] += values[index];
        }
    }
}

type TreeBin = {
    bins: Float64Array;
    nestedPresence: Uint8Array;
    value: number;
};

const EMPTY_SUBTREE = -1;
const MIXED_SUBTREE = -2;

function collectTreeBin(
    tree: SampledTree<unknown>['tree'],
    totals: Float64Array,
    subtreeEntries: Int32Array,
    result: TreeBin[],
    bin: number
) {
    const { nodes, parent } = tree;
    subtreeEntries.fill(EMPTY_SUBTREE);

    for (let node = nodes.length - 1; node >= 0; node--) {
        const entry = nodes[node];
        let present = subtreeEntries[node];

        if (totals[node] > 0) {
            result[entry].bins[bin] += totals[node];

            if (present === EMPTY_SUBTREE) {
                present = entry;
            } else if (present !== entry) {
                present = MIXED_SUBTREE;
            }
        }

        if (present === EMPTY_SUBTREE) {
            continue;
        }

        if (present !== entry) {
            result[entry].nestedPresence[bin] = 1;
        }

        if (node === 0) {
            continue;
        }

        const parentNode = parent[node];
        const parentEntry = subtreeEntries[parentNode];

        if (parentEntry === EMPTY_SUBTREE) {
            subtreeEntries[parentNode] = present;
        } else if (parentEntry !== present) {
            subtreeEntries[parentNode] = MIXED_SUBTREE;
        }
    }
}

function sumTreeRange(
    viewport: PopulationFiltered,
    sampleToNode: Uint32Array,
    totals: Float64Array,
    start: number,
    end: number
) {
    const { samples, values, sinkId, population } = viewport;
    const { cumulative, cumulativeEnd } = population;
    const { first, last, startCut, endCut } = sampleRange(cumulative, end - start, -start, cumulativeEnd);

    if (first > last) {
        return;
    }

    const firstSample = samples[first];

    if (firstSample !== sinkId && values[first] > 0) {
        const node = sampleToNode[firstSample];
        let value = population.values[first] - startCut;

        if (first === last) {
            value -= endCut;
        }

        totals[node] += value;
    }

    if (first === last) {
        return;
    }

    sumTreeEvents(samples, values, sampleToNode, sinkId, totals, first + 1, last);

    const lastSample = samples[last];

    if (lastSample !== sinkId && values[last] > 0) {
        const node = sampleToNode[lastSample];

        totals[node] += population.values[last] - endCut;
    }
}

function binTreePopulation(viewport: PopulationFiltered, metrics: SampledTree<unknown>, count: number, grid: BinGrid) {
    const { tree, sampleToNode } = metrics;
    const { nodes, dictionary } = tree;
    const { total, step, skip } = grid;
    const coverage = viewport.ranges ?? [{ start: 0, end: viewport.cumulativeEnd }];
    // PERF: Reuse one node vector across bins instead of keeping a node-by-bin matrix.
    const totals = new Float64Array(nodes.length);
    const subtreeEntries = new Int32Array(nodes.length);
    const result = dictionary.map(entry => ({
        entry,
        bins: new Float64Array(count),
        nestedPresence: new Uint8Array(count),
        value: 0
    }));
    let rangeIndex = 0;

    for (let bin = 0; bin < count; bin++) {
        const start = bin * step - skip;
        const end = Math.min(total, (bin + 1) * step) - skip;
        totals.fill(0);

        while (rangeIndex < coverage.length && coverage[rangeIndex].end <= start) {
            rangeIndex++;
        }

        for (let range = rangeIndex; range < coverage.length; range++) {
            const interval = coverage[range];

            if (interval.start >= end) {
                break;
            }

            const left = Math.max(start, interval.start);
            const right = Math.min(end, interval.end);

            if (left < right) {
                sumTreeRange(viewport, sampleToNode, totals, left, right);
            }
        }

        collectTreeBin(tree, totals, subtreeEntries, result, bin);

        for (let entry = 0; entry < dictionary.length; entry++) {
            result[entry].value += result[entry].bins[bin];
        }
    }

    return result;
}

type BinOptions = {
    test?: unknown;
    n?: number;
    skip?: number;
    total?: number;
    line?: ProfileLine | ProfileLineType;
    tree?: ProfileLineBreakdown | string;
}

export const methods = {
    binAllocationAttribute(name: ProfileLineAttribute['name'], binCount = 500) {
        const line = resolveScopeProfileLine('memline', this.context);

        if (!line) {
            return [];
        }

        const attribute = line.attributes.find(attribute => attribute.name === name);

        return attribute
            ? methods.binLineToAxisLine.call(this, line, attribute, undefined, binCount)
            : [];
    },

    binTreeSamples(treeMetrics: SampledTree<unknown>, n = 500, breakdown?: ProfileLineBreakdown | string) {
        const resolved = resolveScopeProfileLineBreakdown(breakdown, null, this.context) as ProfileLineBreakdown;
        const { total, skip } = binningRange(resolved.line, resolveScopeViewport(null, this.context), n);

        return binTreePopulation(resolved.populationViewport, treeMetrics, n, {
            total,
            skip,
            step: sampleBinStep(total, n)
        });
    },

    binCount(maxCount: number, rangeOrLength?: Range | number) {
        const range = rangeOrLength ?? resolveScopeViewport(null, this.context);
        const length = isRange(range) ? range.end - range.start : Number(range);

        return Math.max(1, Math.min(maxCount, Math.floor(length)));
    },

    binCallsFromMask(mask: Uint8Array, n = 500, lineTree?: ProfileLineBreakdown | string) {
        const resolvedLineTree = resolveScopeProfileLineBreakdown(lineTree, null, this.context) as ProfileLineBreakdown;
        const { total, skip } = binningRange(resolvedLineTree.line, resolveScopeViewport(null, this.context), n);
        const bins = makeViewportBins(n, mask, resolvedLineTree.populationViewport, total, skip);

        return Array.from(bins);
    },

    binSignals(treeMetrics, options: BinOptions) {
        const {
            test = () => true,
            n = 500,
            skip = 0,
            total,
            line,
            tree: lineTree
        } = options || {};
        const resolvedLineTree = resolveScopeProfileLineBreakdown(lineTree, line, this.context) as ProfileLineBreakdown;
        const { axisTotal } = resolvedLineTree.line;
        const mask = makeSamplesMask(treeMetrics, test);
        const bins = makeViewportBins(n, mask, resolvedLineTree.populationViewport, total ?? axisTotal, skip);

        return bins;
    },

    binCalls(treeMetrics, test, n = 500, breakdown?: ProfileLineBreakdown | string) {
        const resolvedLineTree = resolveScopeProfileLineBreakdown(breakdown, null, this.context) as ProfileLineBreakdown;
        const { total, skip } = binningRange(resolvedLineTree.line, resolveScopeViewport(null, this.context), n);
        const mask = makeSamplesMask(treeMetrics, test);
        const bins = makeViewportBins(n, mask, resolvedLineTree.populationViewport, total, skip);

        // let sum = 0;
        // for (let i = 0; i < bins.length; i++) {
        //     sum += bins[i];
        //     // bins[i] /= step;
        // }
        // bins[0] = step;

        return bins;
    },

    binHeapEvents(
        heapEvents: V8HeapEvent[],
        eventFilter: 'new' | 'delete' = 'new',
        n = 500,
        line?: ProfileLine | ProfileLineType
    ) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { step, skip, binStart, binEnd, start, end: limit } = timestampBins(
            resolvedLine, resolveScopeViewport(null, this.context), n, heapEvents.at(-1)?.tm || 0, 0
        );
        const bins = new Float64Array(n);
        let binIdx = binStart;
        let end = (binIdx + 1) * step - skip;

        for (let i = 0; i < heapEvents.length && binIdx < binEnd && heapEvents[i].tm <= limit; i++) {
            const { tm, event, size } = heapEvents[i];

            if (tm === 0 || tm < start || event !== eventFilter) {
                continue;
            }

            while (tm > end && binIdx < binEnd - 1) {
                binIdx++;
                end += step;
            }

            bins[binIdx] += size;
        }

        return bins;
    },

    binHeapTotal(heapEvents: V8HeapEvent[], n = 500, initial = 0, line?: ProfileLine | ProfileLineType) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { step, skip, binStart, binEnd, start, end: limit } = timestampBins(
            resolvedLine, resolveScopeViewport(null, this.context), n, heapEvents.at(-1)?.tm || 0, 0
        );
        const bins = new Float64Array(n);
        let binIdx = binStart;
        let end = (binIdx + 1) * step - skip;
        let currentSize = initial || 0;
        let currentMax = currentSize;

        for (let i = 0; i < heapEvents.length && binIdx < binEnd && heapEvents[i].tm <= limit; i++) {
            const { tm, event, size } = heapEvents[i];

            if (tm === 0) {
                continue;
            }

            while (tm > end && binIdx < binEnd - 1) {
                bins[binIdx] = currentMax;
                currentMax = currentSize;
                binIdx++;
                end += step;
            }

            currentSize += event === 'new' ? size : -size;
            currentMax = tm < start ? currentSize : Math.max(currentSize, currentMax);
        }

        if (binIdx < binEnd) {
            bins[binIdx] = currentMax;
            bins.fill(currentSize, binIdx + 1, binEnd);
        }

        return bins;
    },

    binAllocations(allocations: Uint32Array, attribute: Uint32Array, attributeNames: string[], n = 500, line?: ProfileLine | ProfileLineType) {
        const { axisTotal: total } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const vectors = Array.from({ length: attributeNames.length }, () => new Uint32Array(n));
        const step = total / n;
        let buffer = 0;
        let binIndex = 0;

        if (attribute) {
            for (let i = 0; i < allocations.length; i++) {
                const vector = vectors[attribute[i]];
                let size = allocations[i];

                while (buffer + size >= step) {
                    const delta = step - buffer;

                    vector[binIndex++] += delta;
                    size -= delta;
                    buffer = 0;
                }

                vector[binIndex] += size;
                buffer += size;
            }
        }

        return vectors.map((vector, index) => {
            return {
                name: attributeNames[index],
                color: typeColor[attributeNames[index]],
                step,
                value: sum(vector),
                total,
                bins: vector
            };
        });
    },

    binLineToAxisLine(
        valuesLine: ProfileLine,
        attribute: ProfileLineAttribute | null,
        axisLine?: ProfileLine,
        n = 500
    ) {
        axisLine = resolveScopeProfileLine(axisLine, this.context) || valuesLine;

        const scopeBreakdown = resolveScopeProfileLineBreakdown(null, null, this.context);
        const populationBreakdown = scopeBreakdown?.line === valuesLine ? scopeBreakdown : valuesLine.breakdowns[0];
        const viewport = populationBreakdown.populationViewport;
        const { ranges: sourceRanges } = viewport;
        const mappingToLine = valuesLine !== axisLine
            ? valuesLine.mappings[axisLine.type]._mapping
            : null;
        const grid = binningRange(axisLine, resolveScopeViewport(null, this.context), n);
        const { total, step, skip } = grid;
        const binSumVector = new Uint32Array(n);
        const attributeValues = attribute?.values || null;
        const tracks = attribute
            ? attribute.dict.map(() => ({ bins: new Uint32Array(n), value: 0 }))
            : [{ bins: binSumVector, value: 0 }];
        const coversSource = skip >= 0 && skip + viewport.cumulativeEnd <= total;

        if (mappingToLine !== null) {
            const { cumulative } = getCallStackPopulation(axisLine);
            const axisViewport = (scopeBreakdown?.line === axisLine ? scopeBreakdown : axisLine.breakdowns[0]).populationViewport;
            const coversAxis = skip >= 0 && skip + axisViewport.cumulativeEnd <= total;
            const targetBin = createTargetBinReader(axisViewport, cumulative, grid);

            if (n === 1 && sourceRanges === null && coversAxis) {
                binMappedTotals(viewport, tracks, attributeValues, mappingToLine, axisViewport.samples.length, targetBin);
            } else {
                binMappedPopulation(valuesLine, viewport, tracks, attributeValues, mappingToLine, targetBin);
            }
        } else if (n === 1 && attribute && sourceRanges === null && coversSource) {
            const { samplesTotal } = viewport.aggregateBy(attribute.values, attribute.dict.length);

            for (let index = 0; index < tracks.length; index++) {
                tracks[index].value = samplesTotal[index];
                tracks[index].bins[0] = samplesTotal[index];
            }
        } else {
            binPopulation(viewport, tracks, attributeValues, grid);
        }

        if (attribute) {
            for (const { bins } of tracks) {
                addBins(binSumVector, bins);
            }
        }

        const max = Math.max(...binSumVector);

        return tracks.map(({ bins, value }, index) => {
            const entry = attribute ? attribute.dict[index] : null;
            let color = 'green';

            if (typeof entry === 'string') {
                color = typeColor[entry];
            } else if (entry && 'color' in entry) {
                color = entry.color;
            }

            return {
                entry: entry ?? valuesLine.type,
                color,
                value,
                max,
                total: valuesLine.axisTotal,
                step: valuesLine === axisLine
                    ? step
                    : null,
                bins
            };
        });
    },

    binScriptFunctionCodes(functionCodes: { tm: number }[], n = 500, profile?: Profile) {
        const line = getProfileOrScopeProfile(profile, this.context)?.timeline as ProfileLine;
        const { step, skip, binStart, binEnd, start, end: limit } = timestampBins(
            line, resolveScopeViewport(null, this.context), n, functionCodes.at(-1)?.tm || 0
        );
        const bins = new Uint32Array(n);
        let binIdx = binStart;
        let end = (binIdx + 1) * step - skip;

        for (let i = 0; i < functionCodes.length && binIdx < binEnd && functionCodes[i].tm <= limit; i++) {
            const { tm } = functionCodes[i];

            if (tm < start) {
                continue;
            }

            while (tm > end && binIdx < binEnd - 1) {
                binIdx++;
                end += step;
            }

            bins[binIdx] += 1;
        }

        if (binIdx < binEnd - 1) {
            bins.fill(bins[binIdx], binIdx + 1, binEnd);
        }

        return bins;
    },

    binScriptFunctionCodesTotal(functionCodes: CpuProCallFrameCode[], n = 500, profile?: Profile) {
        const line = getProfileOrScopeProfile(profile, this.context)?.timeline as ProfileLine;
        const { step, skip, binStart, binEnd, end: limit } = timestampBins(
            line, resolveScopeViewport(null, this.context), n, functionCodes.at(-1)?.tm || 0
        );
        const binByTier = new Map<V8CallFrameCodeType, Uint32Array>();
        const fnTier = new Map();
        const fnCount = new Uint32Array(n);
        let binIdx = binStart;
        let end = (binIdx + 1) * step - skip;

        for (const tier of vmFunctionStateTiers) {
            binByTier.set(tier, new Uint32Array(n));
        }

        for (let i = 0; i < functionCodes.length && binIdx < binEnd && functionCodes[i].tm <= limit; i++) {
            const { tm, tier, callFrameCodes } = functionCodes[i];

            while (tm > end && binIdx < binEnd - 1) {
                binIdx++;
                fnCount[binIdx] = fnCount[binIdx - 1];

                for (const bins of binByTier.values()) {
                    bins[binIdx] = bins[binIdx - 1];
                }

                end += step;
            }

            const currentTier = fnTier.get(callFrameCodes);
            if (currentTier === undefined) {
                // new function
                binByTier.get(tier)![binIdx]++;
                fnCount[binIdx]++;
            } else if (tier !== currentTier) {
                // maybe change function tier
                binByTier.get(currentTier)![binIdx]--;
                binByTier.get(tier)![binIdx]++;
            }

            fnTier.set(callFrameCodes, tier);
        }

        if (binIdx < binEnd - 1) {
            fnCount.fill(fnCount[binIdx], binIdx + 1, binEnd);
            for (const bins of binByTier.values()) {
                bins.fill(bins[binIdx], binIdx + 1, binEnd);
            }
        }

        return { byTier: [...binByTier.entries()], fnCount: fnCount };
    }
};
