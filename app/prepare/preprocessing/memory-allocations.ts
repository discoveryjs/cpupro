import { sum } from '../utils.js';

export function processMemoryAllocations(
    allocations: number[],
    samplesInterval?: number
) {
    const deltasSum = sum(allocations);

    // compute samples interval as a median of deltas if needed (it might be computed on steps before time deltas processing)
    if (typeof samplesInterval !== 'number') {
        samplesInterval = allocations.slice().sort()[allocations.length >> 1]; // TODO: speedup?
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
