import { typeColor, vmFunctionStateTiers } from '../prepare/const.js';
import { ProfileLine, ProfileLineType } from '../prepare/lines/types.js';
import { sum } from '../prepare/misc/utils.js';
import { Profile } from '../prepare/profile.mjs';
import { CpuProCallFrameCode, V8CallFrameCodeType, V8HeapEvent } from '../prepare/types.js';
import { makeSamplesMask } from './call-tree.js';
import { getProfileOrScopeProfile, resolveScopeProfileLine } from './profile.js';

function makeSampleBins(
    n: number,
    mask: Uint8Array,
    samples: number[] | Uint32Array,
    values: number[] | Uint32Array,
    total: number,
    skip = 0
) {
    const bins = new Float64Array(n);
    const step = total / n;
    let binIdx = Math.floor(skip / step);
    let end = (binIdx + 1) * step;
    let offset = skip;

    for (let i = 0; i < samples.length; i++) {
        const accept = mask[samples[i]];
        const delta = values[i];

        if (offset + delta < end) {
            if (accept) {
                bins[binIdx] += delta;
            }
        } else {
            if (accept) {
                const dx = end - offset;
                let x = delta - dx;

                bins[binIdx++] += dx;
                end += step;

                while (x > step) {
                    bins[binIdx++] += step;
                    x -= step;
                    end += step;
                }

                bins[binIdx] += x;
            } else {
                while (offset + delta > end) {
                    binIdx += 1;
                    end += step;
                }
            }
        }

        offset += delta;
    }

    return bins;
}

type BinOptions = {
    test?: unknown;
    n?: number;
    skip?: number;
    total?: number;
    line?: ProfileLine | ProfileLineType;
}

export const methods = {
    binCallsFromMask(mask: Uint8Array, n = 500, line?: ProfileLine | ProfileLineType) {
        const { samples, values, axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const bins = makeSampleBins(n, mask, samples, values, axisTotal);

        return Array.from(bins);
    },

    binSignals(tree, options: BinOptions) {
        const {
            test = () => true,
            n = 500,
            skip = 0,
            total,
            line
        } = options || {};
        const { samples, values, axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const mask = makeSamplesMask(tree, test);
        const bins = makeSampleBins(n, mask, samples, values, total ?? axisTotal, skip);

        return bins;
    },

    binCalls(tree, test, n = 500, line?: ProfileLine | ProfileLineType) {
        const { samples, values, axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const mask = makeSamplesMask(tree, test);
        const bins = makeSampleBins(n, mask, samples, values, axisTotal);

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
        const { axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const bins = new Float64Array(n);
        const step = axisTotal / n;
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

    binHeapTotal(heapEvents: V8HeapEvent[], n = 500, initial = 0, line?: ProfileLine | ProfileLineType) {
        const { axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const bins = new Float64Array(n);
        const step = axisTotal / n;
        let end = step;
        let binIdx = 0;
        let currentSize = initial || 0;
        let currentMax = currentSize;

        for (let i = 0; i < heapEvents.length; i++) {
            const { tm, event, size } = heapEvents[i];

            if (tm === 0) {
                continue;
            }

            while (tm > end) {
                bins[binIdx] = currentMax;
                currentMax = currentSize;
                binIdx++;
                end += step;
            }

            currentSize += event === 'new' ? size : -size;
            currentMax = Math.max(currentSize, currentMax);
        }

        bins[binIdx] = currentMax;

        if (binIdx < n - 1) {
            bins.fill(currentSize, binIdx + 1);
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
        attribute: Uint32Array | null,
        attributeDict: string[] | null,
        axisLine?: ProfileLine,
        n = 500
    ) {
        axisLine = resolveScopeProfileLine(axisLine, this.context) || valuesLine;

        const { values, mappings } = valuesLine;
        const mappingToLine = valuesLine !== axisLine
            ? mappings[axisLine.type]._mapping
            : null;
        const { samplesMetrics: axisMetrics, axisTotal } = axisLine;
        const binSumVector = new Uint32Array(n);
        const vectors = attribute
            ? Array.from({ length: attributeDict?.length || 0 }, () => new Uint32Array(n))
            : [binSumVector];
        const step = axisTotal / n;

        if (mappingToLine !== null) {
            for (let i = 0; i < mappingToLine.length; i++) {
                const value = values[i];
                const absValue = axisMetrics.cumulative[mappingToLine[i]];
                const binIndex = Math.min(n - 1, Math.floor(absValue / step));
                const vector = vectors[attribute?.[i] ?? 0];

                vector[binIndex] += value;

                if (vector !== binSumVector) {
                    binSumVector[binIndex] += value;
                }
            }
        } else {
            for (let i = 0, binIndex = 0, binValue = 0; i < values.length; i++) {
                const vector = vectors[attribute?.[i] ?? 0];
                let value = values[i];

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
            return {
                entry: attributeDict?.[index] ?? valuesLine.type,
                color: attributeDict ? typeColor[attributeDict[index]] : 'green',
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
        const { axisTotal } = getProfileOrScopeProfile(profile, this.context)?.timeline as ProfileLine;
        const bins = new Uint32Array(n);
        const step = axisTotal / n;
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

    binScriptFunctionCodesTotal(functionCodes: CpuProCallFrameCode[], n = 500, profile?: Profile) {
        const { axisTotal } = getProfileOrScopeProfile(profile, this.context)?.timeline as ProfileLine;
        const step = axisTotal / n;
        const binByTier = new Map<V8CallFrameCodeType, Uint32Array>();
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

        if (binIdx < n - 1) {
            fnCount.fill(fnCount[binIdx], binIdx + 1);
            for (const bins of binByTier.values()) {
                bins.fill(bins[binIdx], binIdx + 1);
            }
        }

        return { byTier: [...binByTier.entries()], fnCount: fnCount };
    }
};
