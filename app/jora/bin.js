import { typeColor, vmFunctionStateTiers } from '../prepare/const.js';
import { sum } from '../prepare/utils.js';
import { makeSamplesMask } from './call-tree.js';

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

export const methods = {
    binCallsFromMask(mask, n = 500, profile = this.context.currentProfile) {
        const { samples, timeDeltas, totalTime } = profile;
        const bins = makeSampleBins(n, mask, samples, timeDeltas, totalTime);

        return Array.from(bins);
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

    binHeapEvents(heapEvents, eventFilter = 'new', n = 500, profile = this.context.currentProfile) {
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

    binHeapTotal(heapEvents, n = 500, initial = 0, profile = this.context.currentProfile) {
        const { totalTime } = profile;
        const bins = new Float64Array(n);
        const step = totalTime / n;
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

    binAllocations(allocations, attribute, attributeNames, n = 500, profile = this.context.currentProfile || this.context.data.currentProfile) {
        const { totalTime: total } = profile;
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
