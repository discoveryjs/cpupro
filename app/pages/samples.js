discovery.page.define('samples', {
    view: 'context',
    context: '{ ...#, currentProfile }',
    data: `{
        $line: scopeLine();
        $totalValue: $line.axisTotal;
        $binCount: 500;
        $sampleBins: $binCount.countSamples();
        $sampleDiscreteBins: $binCount.countSamplesDiscrete();
        $xbins: $binCount.sampleXBins();

        $line,
        $totalValue,
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
                'text:"Samples: " + scopeLine().samples.size()',
                'text:" / Bins: " + binCount',
                'text:" / Bin size: " + (totalValue / binCount).toFixed(1)',
                'text:" / Expected samples per bin: " + (scopeLine().samples.size() / binCount).toFixed(1)',
                'text:" / Actual samples per bin: " + (sampleDiscreteBins | { min(), max() } | `${min} ... ${max}`)',
                'struct:scopeLine().values'
            ]
        },
        {
            view: 'block',
            content: [
                'text:"Sampling interval: " + scopeLine().sourceInfo.samplesInterval',
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
                    duration: '=totalValue',
                    segments: '=binCount',
                    selectionStart: '=line.samplesTimingsFiltered.rangeStart',
                    selectionEnd: '=line.samplesTimingsFiltered.rangeEnd',
                    onChange: (state, name, el, data) => {
                        if (state.timeStart !== null) {
                            data.line.samplesTimingsFiltered.setRange(state.timeStart, state.timeEnd);
                        } else {
                            data.line.samplesTimingsFiltered.resetRange();
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
                //     view: 'sample-histogram',
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
                    view: 'sample-histogram',
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
                    view: 'sample-histogram',
                    bins: '=sampleXBins',
                    color: '="#8db2f8a0"',
                    height: 160
                }
            ]
        }
    ]
});
