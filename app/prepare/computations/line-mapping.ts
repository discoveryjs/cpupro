import { ProfileLine, ProfileLineMapping } from '../lines/types';
import { normalizeRanges, type RangeSet } from './coordinates.js';

function lowerBound(values: Uint32Array, value: number, upper = false) {
    let start = 0;
    let end = values.length;

    while (start < end) {
        const middle = (start + end) >>> 1;

        if (upper ? values[middle] <= value : values[middle] < value) {
            start = middle + 1;
        } else {
            end = middle;
        }
    }

    return start;
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
            const last = lowerBound(allocationStarts, end);

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
    sourceIds: number[],
    destLine: ProfileLine,
    destIds: number[]
): {
    left: ProfileLineMapping,
    right: ProfileLineMapping
} {
    const sourceToDest = new Uint32Array(sourceIds); // [0, 1, 2, 3, 4, ...]
    const destToSource = new Uint32Array(destIds);
    // [0, 0, 1, 1, 1, 3, 3, ...] -> timeline sample ids
    // we attach memline sample id to the cpu sample id it was recorded after

    const lastDestIndex = destToSource.length - 1;
    for (let i = 0, k = 0; i < sourceToDest.length; i++) {
        const allocId = sourceToDest[i];
        let lastSeenDestId = destToSource[k];

        while (k < lastDestIndex && allocId > lastSeenDestId) {
            lastSeenDestId = destToSource[++k];
        }

        sourceToDest[i] = k;
    }

    const source = {
        line: destLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: sourceToDest
    };
    const dest = {
        line: sourceLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: destToSource
    };

    source.inverse = dest;
    dest.inverse = source;

    return {
        left: source,
        right: dest
    };
}
