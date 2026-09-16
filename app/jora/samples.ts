import { ProfileLine, ProfileLineType } from '../prepare/lines/types.js';
import { resolveScopeProfileLine, resolveScopeViewport } from './profile.js';
import { binningRange } from './viewport.js';

export function sampleRange(values: number[] | Uint32Array, total: number, skip: number, sourceTotal: number) {
    let first = 0;
    let last = values.length - 1;
    let start = skip;
    let end = skip + sourceTotal;

    // Trim whole occurrences first; only the two retained boundary values need clipping.
    while (first <= last && start < 0 && start + values[first] <= 0) {
        start += values[first++];
    }

    while (last >= first && end >= total && end - values[last] >= total) {
        end -= values[last--];
    }

    return { first, last, offset: Math.max(0, start), startCut: Math.max(0, -start), endCut: Math.max(0, end - total) };
}

function countSamples(n: number, values: number[] | Uint32Array, total: number, continues: boolean, skip: number, sourceTotal: number) {
    const bins = new Uint32Array(n);
    const step = total / n;
    const { first, last, offset: start, startCut, endCut } = sampleRange(values, total, skip, sourceTotal);
    let binIdx = Math.floor(start / step);
    let end = (binIdx + 1) * step;

    for (let i = first, offset = start; i <= last; i++) {
        const delta = values[i] - (i === first ? startCut : 0) - (i === last ? endCut : 0);

        bins[binIdx] += continues || i !== first || startCut === 0 ? 1 : 0;
        offset += delta;

        if (offset >= end) {
            const nextBin = binIdx + 1;

            binIdx = Math.min(n, Math.floor(offset / step));
            end = (binIdx + 1) * step;

            if (continues) {
                for (let j = nextBin; j < binIdx; j++) {
                    bins[j]++;
                }

                if (offset !== binIdx * step) {
                    bins[binIdx]++;
                }
            }
        }
    }

    return bins;
}

export const methods = {
    countSamples(n = 500, line?: ProfileLine | ProfileLineType) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);

        return countSamples(n, resolvedLine.values, total, true, skip, resolvedLine.axisTotal);
    },

    countSamplesDiscrete(n = 500, line: unknown) {
        const resolvedLine = resolveScopeProfileLine(line, this.context) as ProfileLine;
        const { total, skip } = binningRange(resolvedLine, resolveScopeViewport(null, this.context), n);

        return countSamples(n, resolvedLine.values, total, false, skip, resolvedLine.axisTotal);
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
