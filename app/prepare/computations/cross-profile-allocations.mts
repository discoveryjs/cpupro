import type { Profile } from '../profile.mjs';

export function computeCrossProfileStableAllocations(profiles: Profile[]) {
    const memoryProfiles = profiles.filter(profile =>
        !profile.disabled && profile.type === 'memory'
    );

    if (memoryProfiles.length < 2) {
        return;
    }

    const { _callFramesStable, _samplesStable, _uniqueValuesArray } = memoryProfiles[0];
    const uniqueValuesCount = _uniqueValuesArray.length;
    const MAX_COUNT = 0xffff_ffff;

    _callFramesStable.fill(0);
    _samplesStable.fill(MAX_COUNT);

    for (const profile of memoryProfiles) {
        const {
            samples,
            timeDeltas,
            _samplesAll,
            _uniqueValuesMap,
            _callFramesMap
        } = profile;
        const { sampleIdToNode, nodes, dictionary } = profile.callFramesTree;
        const _samplesSum = new Uint32Array(_callFramesStable.length);
        // const _samplesCheck = new Uint32Array(_callFramesStable.length);

        _samplesAll.fill(0);

        for (let i = 0; i < samples.length; i++) {
            const sampleId = samples[i];
            const value = timeDeltas[i];
            const valueIdx = _uniqueValuesMap.get(value) || 0;
            const callFrameIdx = nodes[sampleIdToNode[sampleId]];
            const callFrame = dictionary[callFrameIdx];
            const callFrameSharedIndex = _callFramesMap.get(callFrame) || 0;

            _samplesAll[callFrameSharedIndex * uniqueValuesCount + valueIdx]++;
            _samplesSum[callFrameSharedIndex] += value;
        }

        // const { callFramesTimingsFiltered } = profile;
        // for (const cf of callFramesTimingsFiltered.entries) {
        //     const callFrameIdx = _callFramesMap.get(cf.entry) || 0;
        //     _samplesCheck[callFrameIdx] = cf.selfTime;
        // }

        for (let i = 0; i < _samplesAll.length; i++) {
            if (_samplesAll[i] < _samplesStable[i]) {
                _samplesStable[i] = _samplesAll[i];
            }
        }

        // for (let i = 0; i < _samplesCheck.length; i++) {
        //     if (_samplesCheck[i] !== _samplesSum[i]) {
        //         console.log(':`((((');
        //         break;
        //     }
        // }

        // console.log({ _samplesSum, _samplesCheck });
    }

    // stable call frames
    for (let c = 0; c < _callFramesStable.length; c++) {
        for (let j = 0; j < uniqueValuesCount; j++) {
            const count = _samplesStable[c * uniqueValuesCount + j];
            if (count !== MAX_COUNT) {
                _callFramesStable[c] += count * _uniqueValuesArray[j];
            }
        }
    }

    // const stableSum = sum(_callFramesStable);
    // const allSamplesSum = sum((profiles[1] || profiles[0])._samplesSum);

    // profile variance
    for (const p of memoryProfiles) {
        const { _samplesAll, _callFramesVariance } = p;

        _callFramesVariance.fill(0);

        for (let i = 0; i < _callFramesVariance.length; i++) {
            for (let j = 0; j < uniqueValuesCount; j++) {
                const k = i * uniqueValuesCount + j;
                if (_samplesStable[k] !== MAX_COUNT) {
                    _callFramesVariance[i] += (_samplesAll[k] - _samplesStable[k]) * _uniqueValuesArray[j];
                }
            }
        }

        // const variance = suma(_callFramesVariance);
        // const check = suma(p._samplesCheck);
        // console.log({ stableSum, variance, check, p: (stableSum / (stableSum + variance)).toFixed(2), ok: (stableSum + variance) === check });
    }

    // console.log({ _samplesStable, _callFramesStable, allSamplesSum, stableSum });
}
