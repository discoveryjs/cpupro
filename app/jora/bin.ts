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
    return roundStep * n - total < roundStep ? roundStep : realStep;
}

function makeSampleBins(
    n: number,
    mask: Uint8Array,
    samples: number[] | Uint32Array,
    values: number[] | Uint32Array,
    total: number,
    skip = 0,
    sourceTotal = total
) {
    const bins = new Float64Array(n);
    const rems = new Float64Array(n);
    const step = sampleBinStep(total, n);
    const { first, last, offset: start, startCut, endCut } = sampleRange(values, total, skip, sourceTotal);
    let binIdx = Math.floor(start / step) | 0;
    let end = (binIdx + 1) * step;
    let offset = start - startCut;
    // Subtract the invisible part of the first occurrence once, before adding its original weight.
    let acc = mask[samples[first]] ? -startCut : 0;

    // Two pass implementation of binning samples into bins, with remainders applied to the next bin
    // allow to keep the main loop simpler (without inner loops) and faster,
    // while still keeping the same time complexity of O(n).
    for (let i = first; i <= last; i++) {
        const accept = mask[samples[i]];
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
    for (let i = 0; i < n; i++) {
        for (let rem = rems[i], j = i + 1; rem > 0 && j < n; j++) {
            const delta = Math.min(rem, step);
            bins[j] += delta;
            rem -= delta;
        }
    }

    // Remainders stop at the output boundary; only the shortened final bin can still contain excess.
    if (endCut > 0 && mask[samples[last]]) {
        bins[n - 1] -= Math.min(endCut, Math.max(0, n * step - total));
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
        const { samples, values } = resolvedLineTree.population;
        const bins = makeSampleBins(n, mask, samples, values, total, skip, resolvedLineTree.line.axisTotal);

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
        const { samples, values } = resolvedLineTree.population;
        const mask = makeSamplesMask(treeMetrics, test);
        const bins = makeSampleBins(n, mask, samples, values, total ?? axisTotal, skip, axisTotal);

        return bins;
    },

    binCalls(treeMetrics, test, n = 500, breakdown?: ProfileLineBreakdown | string) {
        const resolvedLineTree = resolveScopeProfileLineBreakdown(breakdown, null, this.context) as ProfileLineBreakdown;
        const { total, skip } = binningRange(resolvedLineTree.line, resolveScopeViewport(null, this.context), n);
        const { samples, values } = resolvedLineTree.population;
        const mask = makeSamplesMask(treeMetrics, test);
        const bins = makeSampleBins(n, mask, samples, values, total, skip, resolvedLineTree.line.axisTotal);

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

            for (let i = 0; i < mappingToLine.length; i++) {
                const value = values[i];
                const absValue = cumulative[mappingToLine[i]] + skip;
                if (absValue < 0 || absValue > total) {
                    continue;
                }
                const binIndex = Math.min(n - 1, Math.floor(absValue / step)) | 0;
                const vector = vectors[attributeValues?.[i] ?? 0];

                vector[binIndex] += value;

                if (vector !== binSumVector) {
                    binSumVector[binIndex] += value;
                }
            }
        } else {
            const { first, last, offset, startCut, endCut } = sampleRange(values, total, skip, valuesLine.axisTotal);
            let binIndex = Math.floor(offset / step);
            let binValue = offset - binIndex * step;

            for (let i = first; i <= last; i++) {
                const vector = vectors[attributeValues?.[i] ?? 0];
                let value = values[i] - (i === first ? startCut : 0) - (i === last ? endCut : 0);

                while (binValue + value >= step) {
                    const delta = step - binValue;

                    vector[binIndex] += delta;
                    value -= delta;
                    binValue = 0;

                    if (vector !== binSumVector) {
                        binSumVector[binIndex] += delta;
                    }

                    binIndex++;
                }

                vector[binIndex] += value;
                binValue += value;

                if (vector !== binSumVector) {
                    binSumVector[binIndex] += value;
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
