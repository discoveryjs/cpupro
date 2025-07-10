function countSamples(n, values, total, continues = false) {
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
    countSamples(n = 500, profile = this.context.currentProfile) {
        const { timeDeltas, totalTime } = profile;

        return countSamples(n, timeDeltas, totalTime, true);
    },

    countSamplesDiscrete(n = 500, profile = this.context.currentProfile) {
        const { timeDeltas, totalTime } = profile;

        return countSamples(n, timeDeltas, totalTime);
    },

    sampleXBins(n = 500, profile = this.context.currentProfile) {
        const { timeDeltas } = profile;
        let max = 1500; // Math.min(timeDeltas.reduce((m, i) => i > m ? i : m, 0), 2000);
        const step = max / n;
        const bins = new Uint32Array(n);

        for (const d of timeDeltas) {
            const x = Math.min(Math.floor(d / step), n - 1);
            bins[x]++;
        }

        return {
            max,
            bins
        };
    }
};
