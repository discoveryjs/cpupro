import { GeneratedNodes, WellKnownType } from '../types.js';

const NoSamplesType: WellKnownType = 'no-samples';

function sum(array: number[]) {
    let sum = 0;

    for (let i = 0; i < array.length; i++) {
        sum += array[i];
    }

    return sum;
}

export function processTimeDeltas(
    startTime: number,
    endTime: number,
    timeDeltas: number[],
    samples: number[],
    samplePositions?: number[],
    samplesInterval?: number
) {
    fixDeltasOrder(timeDeltas, samples, samplePositions);

    let deltasSum = sum(timeDeltas);

    // compute samples interval as a median of deltas if needed (it might be computed on steps before time deltas processing)
    if (typeof samplesInterval !== 'number') {
        samplesInterval = timeDeltas.slice().sort()[timeDeltas.length >> 1]; // TODO: speedup?
    }

    if (!startTime) {
        startTime = 0;
    }

    const expectedEndTime = startTime + deltasSum;

    if (!endTime || endTime < expectedEndTime) {
        endTime = expectedEndTime + samplesInterval;
    }

    const startNoSamplesTime = timeDeltas[0]; // time before first sample
    const maybeTotalTime = (endTime - startTime) - startNoSamplesTime; // compute potential total time excluding start no samples period

    // shift deltas 1 index left and compute sum of deltas to compute last delta
    // [1, 2, 3, 4, ...] -> [2, 3, 4, ..., x]
    //  ^-- drop (startNoSamplesTime)      ^-- used for lastDelta
    timeDeltas.copyWithin(0, 1);
    deltasSum -= startNoSamplesTime;

    // compute last delta
    const maybeLastDelta = Math.max(0, maybeTotalTime - deltasSum);
    const lastDelta = maybeLastDelta > 2.5 * samplesInterval
        ? samplesInterval
        : maybeLastDelta;

    timeDeltas[timeDeltas.length - 1] = lastDelta;
    deltasSum += lastDelta;

    // compute totalTime and end no samples time
    const totalTime = deltasSum;
    const endNoSamplesTime = maybeTotalTime - totalTime;

    return {
        startTime,
        startNoSamplesTime,
        endTime,
        endNoSamplesTime,
        totalTime,
        samplesInterval
    };
}

export function processMemDeltas(
    startTime: number,
    endTime: number,
    timeDeltas: number[],
    samples: number[],
    samplePositions?: number[],
    samplesInterval?: number
) {
    const deltasSum = sum(timeDeltas);

    // compute samples interval as a median of deltas if needed (it might be computed on steps before time deltas processing)
    if (typeof samplesInterval !== 'number') {
        samplesInterval = timeDeltas.slice().sort()[timeDeltas.length >> 1]; // TODO: speedup?
    }

    return {
        startTime: 0,
        startNoSamplesTime: 0,
        endTime: deltasSum,
        endNoSamplesTime: 0,
        totalTime: deltasSum,
        samplesInterval
    };
}

// Fixes negative deltas in a `timeDeltas` array and ensures the integrity and chronological order of the associated samples.
// It adjusts the deltas to ensure all values are non-negative by redistributing negative deltas across adjacent elements.
// Additionally, it corrects the order of associated samples to match the adjusted timing.
function fixDeltasOrder(timeDeltas: number[], samples: number[], samplePositions?: number[]) {
    for (let i = 0; i < timeDeltas.length; i++) {
        const delta = timeDeltas[i];

        // check if the current delta is negative
        if (delta < 0) {
            // if not the last element, add the current negative delta to the next delta to correct the sequence
            if (i < timeDeltas.length - 1) {
                timeDeltas[i + 1] += delta;
            }

            // set the current delta to 0 if it's the first element, otherwise invert the negative delta to positive
            timeDeltas[i] = i === 0 ? 0 : -delta;

            // if not the first element, adjust the previous delta to include the current negative delta
            if (i > 0) {
                timeDeltas[i - 1] += delta;

                // swap the current and previous samples to reflect the adjusted timing
                swap(samples, i, i - 1);

                // swap samplePositions
                if (Array.isArray(samplePositions)) {
                    swap(samplePositions, i, i - 1);
                }

                // move back two indices to re-evaluate the previous delta in case it became negative due to the adjustment
                i -= 2;
            }
        }
    }
}

function swap(array: number[], i: number, j: number) {
    const sample = array[i];
    array[i] = array[j];
    array[j] = sample;
}

// Sometimes, profilers do not capture samples for extended periods for various reasons.
// Modern profilers also typically may not record idle samples. Therefore, we truncate
// long time deltas (greater than sampleInterval * factor) to prevent distortions in the sample data.
// Other tools assign truncated time to an "(idle)" call frame. CPUpro assigns this time
// to a special "(no samples)" call frame, which is categorized to the "(unknown)" category
// since the exact activity during this period is unknown. In fact, the engine
// can be quite busy during those time intervals and therefore doesn't record samples. So, it's unclear
// how to treat these time intervals in a universal way. Moreover, the "factor" should become configurable
// in the near future, allowing users to adjust the allowed sample duration overshoot relative to sampleInterval,
// which will affect the size of the cut-off time delta (the duration of the "(no samples)" sample).
// This is one more reason to separate "(no samples)" from true "(idle)" samples (if any).
// It might be beneficial to add additional new samples in "(no samples)" periods, such as "(compiler)"
// or "(garbage collector)", based on data from events, code compilation records, etc.
export function processLongTimeDeltas(
    samplesInterval: number,
    timeDeltas: number[],
    samples: number[],
    samplePositions: number[] | null = null,
    generatedNodes: GeneratedNodes
) {
    // CPUpro uses two factors to truncate long samples.
    // The first factor, `longSampleFactor` (currently 1.5), is used to check if a sample has overshot
    // the duration limit.
    // The second factor, `longSampleCutFactor` (currently 1.2), is used as a baseline to cut the sample
    // into two parts. The lower part becomes the duration of the sample, and the upper part becomes
    // the duration of a "(no samples)" sample.
    // Two factors are used to avoid splitting samples that have only slightly exceeded the `sampleInterval`.
    // In other words, splitting a sample into two parts just because it is slightly longer than
    // the `sampleInterval` is impractical. Despite setting an exact `samplingInterval` for the profile,
    // it usually adds approximately 25% to it. For example, if we set the sampling interval to 1ms,
    // the median will be 1.25ms; for 0.5ms — 0.625ms; for 0.1ms — 0.125ms.
    // Having factors over 1.0 helps reduce gaps between samples and smooths results.
    const longSampleFactor = 1.5;
    const longSampleCutFactor = 1.2; // should be equal or less than longSampleFactor
    const thresholdLongSampleDuration = samplesInterval * longSampleFactor;
    const allowedSampleDuration = samplesInterval * longSampleCutFactor;
    let longTimeDeltasCount = 0;

    // find the number of long time deltas to determine how many new samples will be added
    for (let i = 0; i < timeDeltas.length; i++) {
        if (timeDeltas[i] > thresholdLongSampleDuration) {
            longTimeDeltasCount++;
        }
    }

    if (longTimeDeltasCount > 0) {
        const noSamplesNodeId = generatedNodes.nodeIdSeed++;
        const originalSize = timeDeltas.length;

        // create no-samples node
        generatedNodes.noSamplesNodeId = noSamplesNodeId;
        generatedNodes.callFrames.push(generatedNodes.dict.callFrames.wellKnownIndex[NoSamplesType]);
        generatedNodes.nodeParentId.push(1);
        generatedNodes.parentScriptOffsets.push(-1);

        // extend arrays to prevent
        timeDeltas.length += longTimeDeltasCount;
        samples.length += longTimeDeltasCount;

        if (samplePositions !== null) {
            samplePositions.length += longTimeDeltasCount;
        }

        // enrich arrays with new elements
        for (let i = originalSize + longTimeDeltasCount - 1, j = originalSize - 1; i >= 0; i--, j--) {
            const delta = timeDeltas[j];

            if (delta > thresholdLongSampleDuration) {
                timeDeltas[i - 1] = allowedSampleDuration;
                timeDeltas[i] = delta - allowedSampleDuration;
                samples[i - 1] = samples[j];
                samples[i] = noSamplesNodeId;

                if (samplePositions !== null) {
                    samplePositions[i - 1] = samplePositions[j];
                    samplePositions[i] = -1;
                }

                // additional decrement since we write 2 elements
                i--;
            } else {
                timeDeltas[i] = delta;
                samples[i] = samples[j];

                if (samplePositions !== null) {
                    samplePositions[i] = samplePositions[j];
                }
            }
        }
    }
}
