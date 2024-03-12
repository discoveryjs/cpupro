discovery.page.define('area', {
    view: 'context',
    data: 'areas[=>name = #.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Area" }'
            ],
            content: 'h1:name'
        },

        {
            view: 'block',
            className: 'subject-timeline',
            data: `{
                $subtree: #.data.areasTree.subtreeSamples(@);

                subject: @,
                $subtree,
                totalTimeBins: $subtree.mask.binCallsFromMask(500)
            }`,
            content: [
                'time-ruler{ duration: #.data.totalTime, captions: "top" }',
                {
                    view: 'timeline-segments-bin',
                    bins: '=binCalls(#.data.areasTree, subject, 500)',
                    presence: '=totalTimeBins',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=subject.name.color()',
                    height: 30
                },
                {
                    view: 'timeline-segments-bin',
                    className: 'total-time',
                    bins: '=totalTimeBins',
                    max: '=#.data.totalTime / 500',
                    binsMax: true,
                    color: '=subject.name.color()',
                    height: 30
                },
                {
                    view: 'list',
                    className: 'nested-work',
                    data: `
                        $selector: subtree.sampleSelector;
                        subtree.entries.sort(id asc).(
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
            data: '#.data.areasTimings.entries[=>entry = @].entry',
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
            when: 'name = "script"',
            data: '#.data.packagesTimings.entries.[entry.area = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Packages "', 'badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[entry.name ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Package', sorting: 'entry.name asc', content: 'package-badge:entry' },
                            { header: 'Modules', data: 'entry.modules' },
                            { header: 'Functions', data: 'entry.modules.functions' }
                        ]
                    }
                }
            ]
        },

        {
            view: 'context',
            data: '#.data.modulesTimings.entries.[entry.area = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Modules "', 'badge:size()'] },
                {
                    view: 'content-filter',
                    content: {
                        view: 'table',
                        data: '.[entry.name ~= #.filter]',
                        cols: [
                            { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                            { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                            { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                            { header: 'Module', sorting: 'entry.name ascN',content: 'module-badge:entry' },
                            { header: 'Functions', data: 'entry.functions' }
                        ]
                    }
                }
            ]
        }
    ]
});
