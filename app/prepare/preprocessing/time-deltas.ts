export function processTimeDeltas(
    timeDeltas: number[],
    samples: number[],
    startTime: number,
    endTime: number,
    samplePositions?: number[],
    samplesInterval?: number
) {
    fixDeltasOrder(timeDeltas, samples, samplePositions);

    const startNoSamplesTime = timeDeltas[0]; // time before first sample
    const maybeTotalTime = (endTime - startTime) - startNoSamplesTime; // compute potential total time excluding start no samples period

    let deltasSum = 0;

    // shift deltas 1 index left and compute sum of deltas to compute last delta
    for (let i = 1; i < timeDeltas.length; i++) {
        deltasSum += timeDeltas[i - 1] = timeDeltas[i];
    }

    // compute samples interval as a median of deltas if needed (it might be computed on steps before time deltas processing)
    if (typeof samplesInterval !== 'number') {
        samplesInterval = timeDeltas.slice().sort()[timeDeltas.length >> 1]; // TODO: speedup?
    }

    // compute last delta
    const maybeLastDelta = maybeTotalTime - deltasSum;
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
