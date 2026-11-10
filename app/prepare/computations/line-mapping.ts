import { ProfileLine, ProfileLineMapping } from '../lines/types';
import type { AllocationIdVector } from '../types.js';
import { normalizeRanges, type RangeSet } from './coordinates.js';
import { lowerBound } from './misc.js';

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

    const allocationPopulation = allocations.breakdowns[0].population;
    const timePopulation = time.breakdowns[0].population;
    const allocationStarts = allocationPopulation.cumulative;
    const timeStarts = timePopulation.cumulative;
    const mapping = relation._mapping;
    const result: { start: number; end: number }[] = [];

    for (const { start, end } of source.range.frame.rebase(ranges)) {
        if (source === time) {
            const first = lowerBound(mapping, lowerBound(timeStarts, start));
            const last = lowerBound(mapping, lowerBound(timeStarts, end));

            if (first < last) {
                result.push({
                    start: allocationStarts[first],
                    end: allocationStarts[last] ?? allocationPopulation.cumulativeEnd
                });
            }
        } else if (end > 0 && start < allocationPopulation.cumulativeEnd) {
            const first = Math.max(0, lowerBound(allocationStarts, start, true) - 1);
            // Allocations without a sample, after the CPU profile ended, have no time
            const last = Math.min(
                lowerBound(allocationStarts, end),
                lowerBound(mapping, timeStarts.length)
            );

            if (first < last) {
                result.push({
                    start: timeStarts[mapping[first]],
                    end: timeStarts[mapping[last - 1] + 1] ?? timePopulation.cumulativeEnd
                });
            }
        }
    }

    return target.range.frame.resolve(normalizeRanges(result));
}

export function createLineMapping(
    sourceLine: ProfileLine,
    sourceIds: AllocationIdVector,
    destLine: ProfileLine,
    destIds: AllocationIdVector
): {
    left: ProfileLineMapping,
    right: ProfileLineMapping
} {
    const sourceToDest = new Uint32Array(sourceIds); // [0, 1, 2, 3, 4, ...]
    const destToSource = new Uint32Array(destIds);
    // [0, 0, 1, 1, 1, 3, 3, ...] -> timeline sample ids
    // An allocation maps to the first CPU sample whose last allocation ID is at or after its ID. Allocations
    // after the last sample's ID were recorded after the CPU profile ended: they map to the sample count, the
    // sample of no time a profile ends with for them, rather than to the last sample
    for (let i = 0, k = 0; i < sourceToDest.length; i++) {
        const allocId = sourceToDest[i];

        while (k < destToSource.length && allocId > destToSource[k]) {
            k++;
        }

        sourceToDest[i] = k;
    }

    const source = {
        line: destLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: sourceToDest,
        // The target cursor above never moves backward
        nondecreasing: true
    };
    const dest = {
        line: sourceLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: destToSource,
        // Recorded allocation IDs, not ordered by construction
        nondecreasing: false
    };

    source.inverse = dest;
    dest.inverse = source;

    return {
        left: source,
        right: dest
    };
}
