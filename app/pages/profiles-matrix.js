const { createElement } = require('@discoveryjs/discovery/utils');

const intersectionTable = {
    view: 'table',
    limit: false,
    cols: [
        { header: 'Profiles', data: 'profiles' },
        { header: 'Call frames', data: 'callFrames' },
        { header: '%', className: 'number', data: 'callFramesPercent | percent()' },
        { header: '∑ Avg samples', className: 'number', data: 'samples' },
        { header: '%', className: 'number', data: 'samplesPercent | percent()' },
        { header: '∑ Avg self time', className: '=profiles = profilesTotal ? "green-line number" : "number"', content: 'text:selfTime | ms()' },
        { header: '%', className: 'number', data: 'selfTimePercent | percent()' },
        { header: '∑ Norm avg self time', className: '=profiles = profilesTotal ? "green-line number" : "number"', content: 'text:selfTime2 | ms()' },
        { header: '%', className: 'number', data: 'selfTimePercent2 | percent()' }
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
    `,
    postRender(el, _, data) {
        const rowEl = createElement('tr', 'view-table-row');

        rowEl.style.color = '#888';
        el.append(createElement('tbody', null, [
            createElement('tr', 'view-table-row', [createElement('td', { colSpan: 100 })]),
            rowEl
        ]));

        rowEl.append(
            createElement('td', null, ''),
            createElement('td', 'view-table-cell number', [data.reduce((s, e) => s + e.callFrames.length, 0)]),
            createElement('td', 'view-table-cell number', '100%'),
            createElement('td', 'view-table-cell number', [data.reduce((s, e) => s + e.samples, 0)]),
            createElement('td', 'view-table-cell number', '100%'),
            createElement('td', 'view-table-cell number red-line', [(data.reduce((s, e) => s + e.selfTime, 0) / 1000).toFixed(1) + 'ms']),
            createElement('td', 'view-table-cell number', '100%'),
            createElement('td', 'view-table-cell number orange-line', [(data.reduce((s, e) => s + e.selfTime2, 0) / 1000).toFixed(1) + 'ms']),
            createElement('td', 'view-table-cell number', '100%')
        );
    }
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
                    'text-numeric:profiles.[not disabled].avg(=>totalTime).ms()'
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
                    const { callFrames } = shared;
                    const records = [];
                    let avgTotalTime = 0;
                    let avgTotalTime2 = 0;
                    let avgTotalTimeAll = 0;

                    for (const callFrame of callFrames) {
                        const rec = {
                            callFrame,
                            min: Infinity,
                            max: 0,
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
                            rec.avg = rec.sum / rec.presence;
                            rec.avg2 = rec.sum / profiles.length;
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
                                content: 'text:selfTime.ms()'
                            })),
                            {
                                header: 'avg',
                                className: 'number metric',
                                data: 'avg',
                                content: 'text:ms()'
                            },
                            {
                                header: 'mid',
                                className: 'number mid-metric',
                                content: 'text:min + (max - min) / 2 | ms()'
                            },
                            {
                                header: '±',
                                className: 'number mid-metric',
                                content: 'text:(max - min) / 2 | "±" + ms()'
                            },
                            {
                                header: '±',
                                className: 'number mid-metric',
                                content: 'text:$diff:(max - min) / 2; max ? ($diff / (min + $diff) | "±" + percent()) : ""'
                            },
                            {
                                header: 'stdev',
                                className: 'number metric',
                                data: 'entries |? stdev(=>selfTime | is number?) : 0',
                                content: 'text:ms()'
                            },
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
    content: [
        { when: 'profiles.size() <= 1', content: {
            view: 'alert-warning',
            content: 'md:"..."'
        } },
        { content: pageContent }
    ]
});
