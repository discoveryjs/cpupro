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
import type { PopulationFiltered } from '../prepare/computations/population.js';

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
    samples: number[] | Uint32Array,
    values: number[] | Uint32Array,
    cumulative: Uint32Array,
    acceptedValues: Uint32Array,
    total: number,
    skip = 0,
    sourceTotal = total,
    range: Range = { start: 0, end: total }
) {
    const bins = new Float64Array(n);
    const rems = new Float64Array(n);
    const step = sampleBinStep(total, n);
    const { first, last, offset: localStart, startCut, endCut } = sampleRange(cumulative, range.end - range.start, skip - range.start, sourceTotal);
    const start = localStart + range.start;
    const lastBin = Math.min(n - 1, Math.ceil(range.end / step) - 1);
    let binIdx = Math.floor(start / step) | 0;
    let end = (binIdx + 1) * step;
    let offset = start - startCut;
    let acc = startCut > 0 && mask[samples[first]] && acceptedValues[first] > 0
        ? -startCut
        : 0;

    // Two pass implementation of binning samples into bins, with remainders applied to the next bin
    // allow to keep the main loop simpler (without inner loops) and faster,
    // while still keeping the same time complexity of O(n).
    for (let i = first; i <= last; i++) {
        const accept = mask[samples[i]] && acceptedValues[i] > 0;
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

    if (endCut > 0 && mask[samples[last]] && acceptedValues[last] > 0) {
        bins[lastBin] -= Math.min(endCut, Math.max(0, (lastBin + 1) * step - range.end));
    }

    return bins;
}

function makeViewportBins(n: number, mask: Uint8Array, viewport: PopulationFiltered, total: number, skip: number) {
    const { samples, values, population, ranges } = viewport;

    if (ranges === null) {
        return makeSampleBins(n, mask, samples, population.values, population.cumulative, values, total, skip, population.cumulativeEnd);
    }

    const bins = new Float64Array(n);

    for (const range of ranges) {
        const start = Math.max(0, range.start + skip);
        const end = Math.min(total, range.end + skip);

        if (start < end) {
            const part = makeSampleBins(n, mask, samples, population.values, population.cumulative, values, total, skip, population.cumulativeEnd, { start, end });

            for (let index = 0; index < n; index++) {
                bins[index] += part[index];
            }
        }
    }

    return bins;
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

        const { values, mappings } = valuesLine;
        const scopeBreakdown = resolveScopeProfileLineBreakdown(null, null, this.context);
        const populationBreakdown = scopeBreakdown?.line === valuesLine ? scopeBreakdown : valuesLine.breakdowns[0];
        const viewport = populationBreakdown.populationViewport;
        const { samples, values: acceptedValues, sinkId, ranges: sourceRanges, cumulative: sourceCumulative } = viewport;
        const mappingToLine = valuesLine !== axisLine
            ? mappings[axisLine.type]._mapping
            : null;
        const { total, step, skip } = binningRange(axisLine, resolveScopeViewport(null, this.context), n);
        const binSumVector = new Uint32Array(n);
        const attributeValues = attribute?.values || null;
        const attributeDict = attribute?.dict || null;
        const vectors = attribute
            ? Array.from({ length: attributeDict?.length || 0 }, () => new Uint32Array(n))
            : [binSumVector];

        if (mappingToLine !== null) {
            const { cumulative } = getCallStackPopulation(axisLine);
            const axisViewport = (scopeBreakdown?.line === axisLine ? scopeBreakdown : axisLine.breakdowns[0]).populationViewport;
            const { samples: axisSamples, values: axisValues, sinkId: axisSinkId, ranges: axisRanges } = axisViewport;
            let axisRangeIndex = 0;
            let previousTarget = -1;
            let binIndex = -1;
            let boundaryIndex = -1;
            let boundaryValue = 0;

            const targetBin = (target: number) => {
                const coordinate = cumulative[target];
                const absValue = coordinate + skip;

                if (!(absValue >= 0 && absValue < total) || axisSamples[target] === axisSinkId || axisValues[target] === 0) {
                    return -1;
                }

                if (axisRanges) {
                    while (axisRangeIndex < axisRanges.length && axisRanges[axisRangeIndex].end <= coordinate) {
                        axisRangeIndex++;
                    }

                    if (axisRangeIndex === axisRanges.length || coordinate < axisRanges[axisRangeIndex].start) {
                        return -1;
                    }
                }

                return Math.floor(absValue / step);
            };
            const flushBoundary = () => {
                if (boundaryIndex !== -1 && samples[boundaryIndex] !== sinkId && acceptedValues[boundaryIndex] > 0) {
                    const target = targetBin(mappingToLine[boundaryIndex]);

                    if (target !== -1) {
                        const vector = attributeValues
                            ? vectors[attributeValues[boundaryIndex]]
                            : binSumVector;

                        vector[target] += boundaryValue;
                    }
                }

                boundaryIndex = -1;
                boundaryValue = 0;
            };

            for (const range of sourceRanges ?? [{ start: 0, end: viewport.cumulativeEnd }]) {
                const { first, last, startCut, endCut } = sampleRange(sourceCumulative, range.end - range.start, -range.start, valuesLine.axisTotal);

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
                    const target = mappingToLine[index];

                    if (target !== previousTarget) {
                        previousTarget = target;
                        binIndex = targetBin(target);
                    }

                    if (binIndex !== -1 && samples[index] !== sinkId) {
                        const vector = attributeValues
                            ? vectors[attributeValues[index]]
                            : binSumVector;

                        vector[binIndex] += acceptedValues[index];
                    }
                }

                boundaryIndex = last;
                boundaryValue = values[last] - endCut;
            }

            flushBoundary();
        } else {
            for (const range of sourceRanges ?? [{ start: 0, end: viewport.cumulativeEnd }]) {
                const start = Math.max(0, range.start + skip);
                const end = Math.min(total, range.end + skip);

                if (start >= end) {
                    continue;
                }

                const { first, last, startCut, endCut } = sampleRange(sourceCumulative, end - start, skip - start, valuesLine.axisTotal);

                if (first > last) {
                    continue;
                }

                const addBoundary = (index: number, startCut: number, endCut: number) => {
                    if (samples[index] === sinkId || acceptedValues[index] === 0) {
                        return;
                    }

                    const vector = attributeValues
                        ? vectors[attributeValues[index]]
                        : binSumVector;
                    const offset = sourceCumulative[index] + skip + startCut;
                    let binIndex = Math.floor(offset / step);
                    let binValue = offset - binIndex * step;
                    let value = values[index] - startCut - endCut;

                    while (binValue + value >= step) {
                        const delta = step - binValue;
                        vector[binIndex] += delta;
                        value -= delta;
                        binValue = 0;
                        binIndex++;
                    }

                    if (value > 0) {
                        vector[binIndex] += value;
                    }
                };

                addBoundary(first, startCut, first === last ? endCut : 0);

                const offset = sourceCumulative[first] + values[first] + skip;
                let binIndex = Math.floor(offset / step);
                let binValue = offset - binIndex * step;

                for (let index = first + 1; index < last; index++) {
                    const vector = attributeValues ? vectors[attributeValues[index]] : binSumVector;
                    const accept = samples[index] !== sinkId && acceptedValues[index] > 0;
                    let value = values[index];

                    while (binValue + value >= step) {
                        const delta = step - binValue;

                        if (accept) {
                            vector[binIndex] += delta;
                        }

                        value -= delta;
                        binValue = 0;
                        binIndex++;
                    }

                    if (accept) {
                        vector[binIndex] += value;
                    }

                    binValue += value;
                }

                if (last !== first) {
                    addBoundary(last, 0, endCut);
                }
            }
        }

        if (attribute) {
            for (const vector of vectors) {
                for (let index = 0; index < n; index++) {
                    binSumVector[index] += vector[index];
                }
            }
        }

        const max = Math.max(...binSumVector);

        return vectors.map((vector, index) => {
            const entry = attributeDict ? attributeDict[index] : null;
            const color: string = typeof entry === 'string'
                ? typeColor[entry]
                : entry?.color || 'green';

            return {
                entry: attribute?.dict[index] ?? valuesLine.type,
                color,
                value: sum(vector),
                max,
                total: valuesLine.axisTotal,
                step: valuesLine === axisLine
                    ? step
                    : null,
                bins: vector
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
