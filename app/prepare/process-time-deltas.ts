// Fixes negative deltas in a `timeDeltas` array and ensures the integrity and chronological order of the associated samples.
// It adjusts the deltas to ensure all values are non-negative by redistributing negative deltas across adjacent elements.
// Additionally, it corrects the order of associated samples to match the adjusted timing.
function fixDeltasOrder(timeDeltas: number[], samples: number[]) {
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
                const sample = samples[i];
                samples[i] = samples[i - 1];
                samples[i - 1] = sample;

                // move back two indices to re-evaluate the previous delta in case it became negative due to the adjustment
                i -= 2;
            }
        }
    }
}

export function processTimeDeltas(timeDeltas: number[], samples: number[], startTime: number, endTime: number) {
    fixDeltasOrder(timeDeltas, samples);

    const startOverheadTime = timeDeltas[0];
    const totalTime = (endTime - startTime) - startOverheadTime; // compute total time excluding start overhead duration

    let deltasSum = 0;

    // shift deltas 1 index left and compute sum of deltas to compute last delta
    for (let i = 1; i < timeDeltas.length; i++) {
        deltasSum += timeDeltas[i - 1] = timeDeltas[i];
    }

    // set last delta
    timeDeltas[timeDeltas.length - 1] = totalTime - deltasSum;

    return {
        startTime,
        startOverheadTime,
        endTime,
        totalTime
    };
}
