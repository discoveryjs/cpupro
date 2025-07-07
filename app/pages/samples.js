discovery.page.define('samples', {
    view: 'context',
    context: '{ ...#, currentProfile }',
    data: `{
        $totalTime: currentProfile.totalTime;
        $binCount: 500;
        $sampleBins: $binCount.countSamples();
        $sampleDiscreteBins: $binCount.countSamplesDiscrete();
        $xbins: $binCount.sampleXBins();

        currentProfile,
        $totalTime,
        $binCount,
        $sampleBins,
        $sampleDiscreteBins,
        sampleBinsMax: [$sampleBins.max(), $sampleDiscreteBins.max()].max(),
        sampleXBins: $xbins.bins,
        sampleXBinsMax: $xbins.max
    }`,
    modifiers: [
    ],
    content: [
        {
            view: 'block',
            content: [
                'text:"Samples: " + currentProfile.samples.size()',
                'text:" / Bins: " + binCount',
                'text:" / Bin size: " + (totalTime / binCount).toFixed(1)',
                'text:" / Expected samples per bin: " + (currentProfile.samples.size() / binCount).toFixed(1)',
                'text:" / Actual samples per bin: " + (sampleDiscreteBins | { min(), max() } | `${min} ... ${max}`)',
                'struct:currentProfile.timeDeltas'
            ]
        },
        {
            view: 'block',
            content: [
                'text:"Sampling interval: " + currentProfile.sourceInfo.samplesInterval',
                'html:"<br>"'
                // 'text:"Estimated sampling interval: " + currentProfile.timeDeltas.estimateSamplingInterval().toFixed(0)'
            ]
        },
        {
            view: 'block',
            className: 'timeline',
            content: [
                {
                    view: 'time-ruler',
                    labels: 'top',
                    duration: '=totalTime',
                    segments: '=binCount',
                    selectionStart: '=#.currentProfile.samplesTimingsFiltered.rangeStart',
                    selectionEnd: '=#.currentProfile.samplesTimingsFiltered.rangeEnd',
                    onChange: (state, name, el, data, context) => {
                        if (state.timeStart !== null) {
                            context.currentProfile.samplesTimingsFiltered.setRange(state.timeStart, state.timeEnd);
                        } else {
                            context.currentProfile.samplesTimingsFiltered.resetRange();
                        }
                    },
                    details: [
                        // 'text:"Continues: " + sampleBins[#.segmentStart:#.segmentEnd + 1].sum()',
                        // 'html:"<br>"',
                        'text:"Discrete: " + sampleDiscreteBins[#.segmentStart:#.segmentEnd + 1].sum()'
                    ]
                },
                // {
                //     view: 'block',
                //     content: [
                //         'text:"Continues"'
                //     ]
                // },
                // {
                //     view: 'timeline-segments-bin',
                //     bins: '=sampleBins',
                //     max: '=sampleBinsMax',
                //     // binsMax: true,
                //     color: '="#bfbf3ba0"',
                //     height: 75
                // },
                {
                    view: 'block',
                    content: [
                        'text:"Discrete"'
                    ]
                },
                {
                    view: 'timeline-segments-bin',
                    bins: '=sampleDiscreteBins',
                    max: '=sampleBinsMax',
                    // binsMax: true,
                    color: '="#81ad52a0"',
                    height: 75
                }
            ]
        },
        {
            view: 'block',
            className: 'timeline',
            content: [
                {
                    view: 'time-ruler',
                    labels: 'top',
                    duration: '=sampleXBinsMax',
                    segments: '=binCount',
                    details: [
                        {
                            view: 'switch',
                            data: '',
                            content: [
                                { when: '#.timeStart != #.timeEnd - 1', content: 'text:`Range: ${#.timeStart}..${#.timeEnd - 1}`' },
                                { content: 'text:`Value: ${#.timeStart}`' }
                            ]
                        },
                        'html:"<br>"',
                        'text:`Samples: ${sampleXBins[#.segmentStart:#.segmentEnd + 1].sum()}`'
                    ]
                },
                {
                    view: 'timeline-segments-bin',
                    bins: '=sampleXBins',
                    color: '="#8db2f8a0"',
                    height: 160
                }
            ]
        }
    ]
});
