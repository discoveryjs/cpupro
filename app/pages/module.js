discovery.page.define('module', {
    view: 'context',
    data: 'modules[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Module" }',
                'badge{ className: "area-badge", text: area.name, href: area.marker().href, color: area.name.color() }',
                'package-badge'
            ],
            content: 'h1:packageRelPath or name or path'
        },

        {
            view: 'block',
            className: 'subject-timeline',
            data: `{
                $subtree: #.data.modulesTree.subtreeSamples(@);

                subject: @,
                $subtree,
                totalTimeBins: $subtree.mask.binCallsFromMask(500)
            }`,
            content: [
                'time-ruler{ duration: #.data.totalTime, captions: "top" }',
                {
                    view: 'timeline-segments-bin',
                    bins: '=binCalls(#.data.modulesTree, subject, 500)',
                    presence: '=totalTimeBins',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=subject.area.name.color()',
                    height: 30
                },
                {
                    view: 'timeline-segments-bin',
                    className: 'total-time',
                    bins: '=totalTimeBins',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=subject.area.name.color()',
                    height: 30
                },
                {
                    view: 'list',
                    className: 'nested-work',
                    whenData: true,
                    data: `
                        $selector: subtree.sampleSelector;
                        subtree.entries.area.sort(id asc).(
                            $area:$;
                            { $area, bins: binCalls(#.data.areasTree, =>($=$area and $selector($$)), 500) }
                        )
                    `,
                    item: {
                        view: 'timeline-segments-bin',
                        bins: '=bins',
                        max: '=#.data.totalTime / 500',
                        binsMax: true,
                        color: '=area.name.color()',
                        height: 20
                    }
                }
            ]
        },

        {
            view: 'block',
            className: 'indicators',
            data: '#.data.modulesTimings.entries[=>entry = @]',
            content: [
                {
                    view: 'page-indicator',
                    title: 'Self time',
                    value: '=selfTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Self time, %',
                    value: '=selfTime.totalPercent()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time',
                    value: '=totalTime.ms()',
                    unit: true
                },
                {
                    view: 'page-indicator',
                    title: 'Total time, %',
                    value: '=totalTime.totalPercent()',
                    unit: true
                }
            ]
        },

        {
            view: 'context',
            data: '#.data.functionsTimings.entries.[entry.module = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Functions "', 'badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[entry.name ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Function', sorting: 'entry.name ascN', content: 'auto-link{ data: entry, content: "text-match:{ ..., match: #.filter }" }' },
                            { header: 'Loc', data: 'entry', sorting: 'entry.loc ascN', content: ['module-badge', 'loc-badge'] }
                        ]
                    }
                }
            ]
        }
    ]
});
