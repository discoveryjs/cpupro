import type { ProfileLine, ProfileLineMapping } from '../lines/types.js';
import type { AllocationIdVector } from '../types.js';
import { normalizeRanges, type RangeSet } from './coordinates.js';
import { lowerBound } from './misc.js';

// Positions of a line's events on its own axis: their starts and the end of the last one. Populations of a line
// share them, so the first one gives them, until the structure of lines decides who owns the positions of events
export function lineEventPositions(line: Pick<ProfileLine, 'breakdowns'>) {
    const { cumulative, cumulativeEnd } = line.breakdowns[0].population;

    return {
        starts: cumulative,
        end: cumulativeEnd
    };
}

export function mapLineRanges(source: ProfileLine, target: ProfileLine, ranges: RangeSet | null): RangeSet | null | undefined {
    const allocations = source.kind === 'memory' ? source : target;
    const time = source.kind === 'time' ? source : target;
    const relation = allocations.mappings[time.type];

    if (allocations.kind !== 'memory' || time.kind !== 'time' || relation?.line !== time) {
        return undefined;
    }

    if (ranges === null) {
        return null;
    }

    const allocationPositions = lineEventPositions(allocations);
    const timePositions = lineEventPositions(time);
    const allocationStarts = allocationPositions.starts;
    const timeStarts = timePositions.starts;
    const mapping = relation._mapping;
    const sourceRanges = source.range.frame.rebase(ranges);
    const result: { start: number; end: number }[] = [];

    for (let i = 0; i < sourceRanges.length; i++) {
        const start = sourceRanges[i].start;
        const end = sourceRanges[i].end;

        if (source === time) {
            const first = lowerBound(mapping, lowerBound(timeStarts, start));
            const last = lowerBound(mapping, lowerBound(timeStarts, end));

            if (first < last) {
                result.push({
                    start: allocationStarts[first],
                    end: allocationStarts[last] ?? allocationPositions.end
                });
            }
        } else if (end > 0 && start < allocationPositions.end) {
            const first = Math.max(0, lowerBound(allocationStarts, start, true) - 1);
            // Allocations without a sample, after the CPU profile ended, have no time
            const last = Math.min(
                lowerBound(allocationStarts, end),
                lowerBound(mapping, timeStarts.length)
            );

            if (first < last) {
                result.push({
                    start: timeStarts[mapping[first]],
                    end: timeStarts[mapping[last - 1] + 1] ?? timePositions.end
                });
            }
        }
    }

    return target.range.frame.resolve(normalizeRanges(result));
}

// The CPU sample of every allocation: the first sample whose last allocation ID is at or after the allocation's ID.
// Only the first `sampleCount` IDs are of samples; an allocation after the last of them maps to the next index
export function mapAllocationsToSamples(
    allocationIds: AllocationIdVector,
    sampleAllocationIds: Uint32Array,
    sampleCount: number
) {
    const allocationSamples = new Uint32Array(allocationIds.length);
    const recordedSamples = Math.min(sampleAllocationIds.length, sampleCount);
    let sample = 0;

    for (let i = 0; i < allocationIds.length; i++) {
        while (sample < recordedSamples && allocationIds[i] > sampleAllocationIds[sample]) {
            sample++;
        }

        allocationSamples[i] = sample;
    }

    return allocationSamples;
}

// Whether allocations were recorded after every sample: every sample records an ID and the last allocation's ID is
// after all of them. Allocation IDs ascend, so the last allocation is after every sample another allocation passed,
// and mapAllocationsToSamples() maps it to the sample after the recorded ones exactly then
export function hasAllocationsAfterSamples(
    allocationIds: AllocationIdVector,
    sampleAllocationIds: Uint32Array,
    sampleCount: number
) {
    if (allocationIds.length === 0 || sampleCount === 0 || sampleAllocationIds.length < sampleCount) {
        return false;
    }

    const lastId = allocationIds[allocationIds.length - 1];

    for (let i = 0; i < sampleCount; i++) {
        if (sampleAllocationIds[i] >= lastId) {
            return false;
        }
    }

    return true;
}

// Mappings between the memline and the timeline: the CPU sample of every allocation, and the last allocation ID
// of every CPU sample
export function createLineMapping(
    memline: ProfileLine,
    allocationSamples: Uint32Array,
    timeline: ProfileLine,
    sampleAllocationIds: Uint32Array
): {
    memlineToTimeline: ProfileLineMapping,
    timelineToMemline: ProfileLineMapping
} {
    const memlineToTimeline = {
        line: timeline,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: allocationSamples,
        // The sample cursor of mapAllocationsToSamples() never moves backward
        nondecreasing: true
    };
    const timelineToMemline = {
        line: memline,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: sampleAllocationIds,
        // Recorded allocation IDs, not ordered by construction
        nondecreasing: false
    };

    memlineToTimeline.inverse = timelineToMemline;
    timelineToMemline.inverse = memlineToTimeline;

    return {
        memlineToTimeline,
        timelineToMemline
    };
}
