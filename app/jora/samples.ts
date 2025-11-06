import { ProfileLine, ProfileLineType } from '../prepare/lines/types.js';
import { resolveScopeProfileLine } from './profile.js';

function countSamples(n: number, values: number[] | Uint32Array, total: number, continues = false) {
    const bins = new Uint32Array(n);
    const step = total / n;
    let end = step;
    let binIdx = 0;

    for (let i = 0, offset = 0; i < values.length; i++) {
        bins[binIdx]++;
        offset += values[i];

        if (offset >= end) {
            binIdx = Math.min(n, Math.floor(offset / step));
            end = (binIdx + 1) * step;

            if (continues) {
                for (let j = Math.floor((offset - values[i]) / step); j < binIdx; j++) {
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
        const { values, axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;

        return countSamples(n, values, axisTotal, true);
    },

    countSamplesDiscrete(n = 500, line: unknown) {
        const { values, axisTotal } = resolveScopeProfileLine(line, this.context) as ProfileLine;

        return countSamples(n, values, axisTotal, false);
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
