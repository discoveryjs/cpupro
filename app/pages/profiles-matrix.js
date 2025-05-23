const intersectionTable = {
    view: 'table',
    limit: false,
    cols: [
        { header: 'Profiles', data: 'profiles' },
        { header: 'Call frames', data: 'callFrames', footer: { data: 'callFrames' } },
        { header: '%', data: 'callFramesPercent | percent()', align: 'right', footer: { align: 'right', content: 'text:"100%"' } },
        { header: '∑ Avg samples', data: 'samples', align: 'right', footer: { align: 'right', data: 'samples.sum()' } },
        { header: '%', data: 'samplesPercent | percent()', align: 'right', footer: { align: 'right', content: 'text:"100%"' } },
        {
            header: '∑ Avg self time',
            className: '=profiles = profilesTotal ? "green-line number" : "number"',
            content: 'text-numeric:selfTime | unit()',
            footer: { className: 'number red-line', data: 'sum(=>selfTime)', content: 'text-numeric:unit()' }
        },
        { header: '%', align: 'right', data: 'selfTimePercent | percent()', footer: { align: 'right', content: 'text:"100%"' } },
        {
            header: '∑ Norm avg self time',
            className: '=profiles = profilesTotal ? "green-line number" : "number"',
            content: 'text-numeric:selfTime2 | unit()',
            footer: { className: 'number orange-line', data: 'sum(=>selfTime2)', content: 'text-numeric:unit()' }
        },
        { header: '%', data: 'selfTimePercent2 | percent()', align: 'right', footer: { align: 'right', content: 'text:"100%"' } }
    ],
    data: `
        $records: records.[presence];
        $total: $records.size();
        $scTotal: $records.sum(=> entries.avg(=> samples));
        $stTotal: $records.sum(=> avg);
        $stTotal2: $records.sum(=> avg2);

        $records
            .group(=> presence)
            .sort(key desc)
            .({
                $sc: value.sum(=> entries.avg(=> samples)).round();
                $st: value.sum(=> avg);
                $st2: value.sum(=> avg2);

                profiles: key,
                profilesTotal: @.profiles.size(),
                callFrames: value,
                callFramesPercent: value.size() / $total,
                samples: $sc,
                samplesPercent: $sc / $scTotal,
                selfTime: $st,
                selfTimePercent: $st / $stTotal,
                selfTime2: $st2,
                selfTimePercent2: $st2 / $stTotal2
            })
    `
};

const pageContent = [
    {
        view: 'page-header',
        content: {
            view: 'h1',
            content: [
                'text:"Profiles matrix"',
                {
                    view: 'text',
                    when: '#.datasets[].resource.type = "file"',
                    data: '": " + #.datasets[].resource.name'
                }
            ]
        }
    },

    {
        view: 'block',
        content: [
            'text:"Samples convolution: "',

            {
                view: 'button',
                text: 'All (demo)',
                data: '#.samplesConvolutionRules.all',
                disabled: '=#.data.currentSamplesConvolutionRule=@',
                onClick: '="setSamplesConvolutionRule".actionHandler(@, =>null)'
            },

            {
                view: 'button',
                text: 'Module',
                data: '#.samplesConvolutionRules.module',
                disabled: '=#.data.currentSamplesConvolutionRule=@',
                onClick: '="setSamplesConvolutionRule".actionHandler(@, =>null)'
            },

            {
                view: 'button',
                text: 'Top level',
                data: '#.samplesConvolutionRules.topLevel',
                disabled: '=#.data.currentSamplesConvolutionRule=@',
                onClick: '="setSamplesConvolutionRule".actionHandler(@, =>null)'
            },

            {
                view: 'button',
                text: 'Profile presence',
                data: '#.samplesConvolutionRules.profilePresence',
                disabled: '=#.data.currentSamplesConvolutionRule=@',
                onClick: '="setSamplesConvolutionRule".actionHandler(@, =>null)'
            },

            {
                view: 'button',
                text: 'Reset',
                data: null,
                disabled: '=#.data.currentSamplesConvolutionRule=@',
                onClick: '="setSamplesConvolutionRule".actionHandler(@, =>null)'
            },

            {
                view: 'block',
                className: 'total-time-info',
                content: [
                    'text:"Avg profile total time: "',
                    'text-numeric:profiles.[not disabled].avg(=>totalTime).unit()',
                    {
                        view: 'context',
                        data: `
                            $activeProfiles: profiles.[not disabled];
                            $stableSum: profiles.[not disabled][]._callFramesStable.sum();

                            {
                                $stableSum,
                                min: $activeProfiles.(totalTime - $stableSum).min(),
                                max: $activeProfiles.(totalTime - $stableSum).max(),
                                avg: $activeProfiles.(totalTime - $stableSum).avg(),
                                avgPercent: $activeProfiles.avg(=>100 * $stableSum / totalTime)
                            }
                        `,
                        whenData: 'stableSum',
                        content: [
                            'text:" / Stable: "',
                            'text-numeric:stableSum.unit()',
                            'text-numeric:` (avg: ${avgPercent.toFixed(2)}%)`',
                            'text:" + " + ((min / 1000).toFixed(1) + "…" + max.unit() + " (avg: " + avg.unit() + ")")'
                        ]
                    }
                ]
            }
        ]
    },

    {
        view: 'context',
        modifiers: [

        ],
        content: [
            {
                view: 'context',
                data(data) {
                    const { profiles: allProfiles, shared } = data;
                    const profiles = allProfiles.filter(p => !p.disabled);
                    const { _callFramesMap, _callFramesStable } = profiles[0];
                    const { callFrames } = shared;
                    const records = [];
                    let avgTotalTime = 0;
                    let avgTotalTime2 = 0;
                    let avgTotalTimeAll = 0;

                    for (const callFrame of callFrames) {
                        const _callFrameIndex = _callFramesMap.get(callFrame);
                        const rec = {
                            callFrame,
                            stable: _callFramesStable[_callFrameIndex],
                            min: Infinity,
                            max: 0,
                            mid: 0,
                            range: 0,
                            sum: 0,
                            avg: 0,
                            avg2: 0,
                            presence: 0,
                            firstProfile: -1,
                            lastProfile: 0,
                            firstSkip: -1,
                            entries: []
                        };

                        for (let i = 0; i < profiles.length; i++) {
                            const entry = profiles[i].callFramesTimingsFiltered.getEntry(callFrame);

                            if (entry?.selfTime > 0) {
                                rec['p' + i] = entry;
                                rec.entries.push(entry);
                                rec.lastProfile = i;
                                rec.sum += entry.selfTime;
                                rec.presence++;

                                if (rec.firstProfile === -1) {
                                    rec.firstProfile = i;
                                }
                                if (entry.selfTime < rec.min) {
                                    rec.min = entry.selfTime;
                                }
                                if (entry.selfTime > rec.max) {
                                    rec.max = entry.selfTime;
                                }
                            } else {
                                if (rec.firstSkip === -1) {
                                    rec.firstSkip = i;
                                }
                            }
                        }

                        if (rec.presence > 0) {
                            rec.avg = Math.round(rec.sum / rec.presence);
                            rec.avg2 = Math.round(rec.sum / profiles.length);
                            rec.range = (rec.max - rec.min) >> 1;
                            rec.mid = rec.min + rec.range;
                            avgTotalTime += rec.avg;
                            avgTotalTime2 += rec.avg2;
                            records.push(rec);
                        }

                        if (rec.presence === profiles.length) {
                            avgTotalTimeAll += rec.avg;
                        }
                    }

                    return {
                        avgTotalTime,
                        avgTotalTime2,
                        avgTotalTimeAll,
                        profiles,
                        records: records.sort((a, b) =>
                            b.presence - a.presence ||
                            a.firstProfile - b.firstProfile ||
                            b.firstSkip - a.firstSkip ||
                            a.lastProfile - b.lastProfile ||
                            b.totalTime - a.totalTime
                        ),
                        cols: [
                            {
                                header: '',
                                content: 'text:""',
                                details: 'struct'
                            },
                            ...profiles.map((_, idx) => ({
                                header: '#' + idx,
                                className: 'timings number',
                                sorting: `p${idx}.selfTime??-1 desc`,
                                data: `p${idx}`,
                                contentWhen: 'selfTime is number',
                                content: 'text:selfTime.unit()'
                            })),
                            {
                                header: 'avg',
                                className: 'number metric vs',
                                data: 'avg',
                                content: 'text:unit()'
                            },
                            {
                                header: 'mid',
                                className: 'number mid-metric vs',
                                content: 'text:mid | unit()'
                            },
                            {
                                header: '±',
                                className: 'number mid-metric',
                                content: 'text:range | "±" + unit()'
                            },
                            {
                                header: '±',
                                className: 'number mid-metric',
                                content: 'text:max ? (range / (min + range) | "±" + percent()) : ""'
                            },
                            {
                                header: 'stdev',
                                className: 'number metric',
                                data: 'entries |? stdev(=>selfTime | is number?) : 0',
                                content: 'text:unit()'
                            },
                            ..._callFramesStable.length ? [
                                {
                                    header: 'stable',
                                    className: 'number metric new',
                                    data: 'stable',
                                    content: ['text: ? unit() : "–"']
                                },
                                {
                                    header: 'avg - st',
                                    className: 'number metric vs',
                                    data: 'avg - stable',
                                    content: ['text: ? unit() : "–"']
                                },
                                {
                                    header: 'mid - st',
                                    className: 'number metric vs',
                                    data: 'mid - stable',
                                    content: ['text: ? unit() : "–"']
                                }
                            ] : [],
                            {
                                header: 'Count',
                                className: 'metric',
                                data: 'presence'
                            },
                            {
                                header: 'Call frame',
                                content: 'call-frame-badge:callFrame'
                            }
                        ]
                    };
                },
                content: [
                    {
                        view: 'block',
                        className: 'pipelines-timeline',
                        context: `{
                            $totalTime: [...profiles.totalTime, /*avgTotalTime,*/ avgTotalTime2, avgTotalTimeAll].max();
                            $startTime: profiles.startTime.min();

                            ...#,
                            $totalTime,
                            $startTime,
                            endTime: $startTime + $totalTime,
                        }`,
                        content: [
                            {
                                view: 'time-ruler',
                                duration: '=#.totalTime'
                            },
                            {
                                view: 'block',
                                className: 'time-line avg-line',
                                data: 'profiles.avg(=>totalTime) / #.totalTime',
                                postRender(el, _, data) {
                                    el.style.setProperty('--x', data);
                                }
                            },
                            {
                                view: 'block',
                                className: 'time-line red-line',
                                postRender(el, _, data, context) {
                                    el.style.setProperty('--x', data.avgTotalTime / context.totalTime);
                                }
                            },
                            {
                                view: 'block',
                                className: 'time-line orange-line',
                                postRender(el, _, data, context) {
                                    el.style.setProperty('--x', data.avgTotalTime2 / context.totalTime);
                                }
                            },
                            {
                                view: 'block',
                                className: 'time-line green-line',
                                postRender(el, _, data, context) {
                                    el.style.setProperty('--x', data.avgTotalTimeAll / context.totalTime);
                                }
                            },
                            {
                                view: 'block',
                                className: 'time-line stable-line',
                                data: 'profiles.[not disabled][]._callFramesStable.sum() / #.totalTime',
                                whenData: true,
                                postRender(el, _, data) {
                                    el.style.setProperty('--x', data);
                                }
                            },
                            {
                                view: 'timeline-profiles',
                                startTime: '=#.startTime',
                                endTime: '=#.endTime',
                                data: '#.data.profiles',
                                whenData: 'size() > 1'
                            }
                        ]
                    },
                    intersectionTable,
                    {
                        view: 'table',
                        rows: '=records',
                        cols: '=cols'
                    }
                ]
            }
        ]
    }
];

discovery.page.define('profiles-matrix', {
    view: 'switch',
    context: '{ ...#, currentProfile }',
    content: [
        { when: 'profiles.size() <= 1', content: {
            view: 'alert-warning',
            content: 'md:"..."'
        } },
        { content: pageContent }
    ]
});
