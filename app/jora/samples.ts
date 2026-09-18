import { ProfileLine, ProfileLineType } from '../prepare/lines/types.js';
import { resolveScopeProfileLine, resolveScopeProfileLineBreakdown, resolveScopeViewport } from './profile.js';
import { binningRange } from './viewport.js';
import { findCumulativeBoundary, type PopulationFiltered } from '../prepare/computations/population.js';

export function sampleRange(cumulative: Uint32Array, total: number, skip: number, sourceTotal: number) {
    const start = Math.max(0, -skip);
    const end = Math.min(sourceTotal, total - skip);

    if (start >= end) {
        return {
            first: 0,
            last: -1,
            offset: 0,
            startCut: 0,
            endCut: 0
        };
    }

    const first = Math.max(0, findCumulativeBoundary(cumulative, start, true) - 1);
    const last = findCumulativeBoundary(cumulative, end, false) - 1;
    const lastEnd = last + 1 < cumulative.length ? cumulative[last + 1] : sourceTotal;

    return {
        first,
        last,
        offset: start + skip,
        startCut: start - cumulative[first],
        endCut: lastEnd - end
    };
}

function countSamples(n: number, viewport: PopulationFiltered, total: number, continues: boolean, skip: number) {
    const bins = new Uint32Array(n);
    const step = total / n;
    const { population, samples, values, sinkId } = viewport;
    const { values: originalValues, cumulative, cumulativeEnd } = population;
    let previousEvent = -1;
    let previousBin = -1;

    for (const range of viewport.ranges ?? [{ start: 0, end: cumulativeEnd }]) {
        const start = Math.max(0, range.start + skip);
        const end = Math.min(total, range.end + skip);

        if (start >= end) {
            continue;
        }

        const { first, last, offset, startCut } = sampleRange(cumulative, end - start, skip - start, cumulativeEnd);
        let position = offset + start - startCut;
        let binIndex = Math.floor((offset + start) / step);
        let binEnd = (binIndex + 1) * step;
        let count = 0;

        if (continues) {
            const lastBin = Math.min(n - 1, Math.ceil(end / step) - 1);

            if (first === previousEvent && binIndex <= previousBin) {
                count = -1;
            }

            for (let index = first; index <= last; index++) {
                const accepted = samples[index] !== sinkId && values[index] > 0;

                if (accepted) {
                    count++;
                }

                position += originalValues[index];

                if (position >= binEnd) {
                    const nextBin = Math.floor(position / step);

                    bins[binIndex] += count;
                    count = 0;

                    if (accepted) {
                        const finish = Math.min(lastBin, position === nextBin * step ? nextBin - 1 : nextBin);

                        for (let crossedBin = binIndex + 1; crossedBin <= finish; crossedBin++) {
                            bins[crossedBin]++;
                        }
                    }

                    binIndex = nextBin;
                    binEnd = (binIndex + 1) * step;
                }
            }

            previousEvent = last >= first && samples[last] !== sinkId && values[last] > 0 ? last : -1;
            previousBin = Math.min(lastBin, Math.ceil(position / step) - 1);
        } else {
            const firstIndex = startCut > 0 ? first + 1 : first;

            position = cumulative[firstIndex] + skip;

            for (let index = firstIndex; index <= last; index++) {
                if (position >= binEnd) {
                    bins[binIndex] += count;
                    count = 0;
                    binIndex = Math.floor(position / step);
                    binEnd = (binIndex + 1) * step;
                }

                if (samples[index] !== sinkId && values[index] > 0) {
                    count++;
                }

                position += originalValues[index];
            }
        }

        bins[binIndex] += count;
    }

    return bins;
}

export const methods = {
    countSamples(n = 500, line?: ProfileLine | ProfileLineType) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);
        const breakdown = resolveScopeProfileLineBreakdown(null, resolvedLine, this.context)!;

        return countSamples(n, breakdown.populationViewport, total, true, skip);
    },

    countSamplesDiscrete(n = 500, line: unknown) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);
        const breakdown = resolveScopeProfileLineBreakdown(null, resolvedLine, this.context)!;

        return countSamples(n, breakdown.populationViewport, total, false, skip);
    },

    sampleXBins(n = 500, line?: ProfileLine | ProfileLineType) {
        const { values } = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const max = 1500; // Math.min(timeDeltas.reduce((m, i) => i > m ? i : m, 0), 2000);
        const step = max / n;
        const bins = new Uint32Array(n);

        for (const d of values) {
            const x = Math.min(Math.floor(d / step), n - 1);
            bins[x]++;
        }

        return {
            max,
            bins
        };
    }
};
