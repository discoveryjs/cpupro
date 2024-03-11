discovery.page.define('package', {
    view: 'context',
    data: 'packages[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge{ className: "type-badge", text: "Package" }',
                'badge{ className: "area-badge", text: area.name, href: area.marker().href, color: area.name.color() }'
            ],
            content: 'h1:name'
        },

        {
            view: 'block',
            className: 'indicators',
            data: '#.data.packagesTimings.entries[=>entry = @].entry',
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
            view: 'block',
            className: 'subject-timeline',
            data: `{
                $subtree: #.data.packagesTree.subtreeSamples(@);

                subject: @,
                $subtree,
                totalTimeBins: $subtree.mask.binCallsFromMask(500)
            }`,
            content: [
                'time-ruler{ duration: #.data.totalTime, captions: "top" }',
                {
                    view: 'timeline-segments-bin',
                    bins: '=binCalls(#.data.packagesTree, subject, 500)',
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
            view: 'context',
            data: '#.data.modulesTimings.entries.[entry.package = @].sort(selfTime desc, totalTime desc)',
            content: [
                { view: 'h2', content: ['text:"Modules "', 'badge:size()'] },
                {
                    view: 'table',
                    cols: [
                        { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                        { header: 'Nested time', sorting: 'nestedTime desc, totalTime desc', content: 'duration:{ time: nestedTime, total: #.data.totalTime }' },
                        { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                        { header: 'Module', sorting: '(entry | packageRelPath or name or path) asc', content: 'module-badge:entry' },
                        { header: 'Functions', data: 'entry.functions' },
                        { header: 'Histogram', content: {
                            view: 'timeline-segments-bin',
                            bins: '=binCalls(#.data.modulesTree, entry, 100)',
                            max: '=#.data.totalTime / 100',
                            binsMax: true,
                            color: '=entry.area.name.color()',
                            height: 22
                        } }
                    ]
                }
            ]
        }
    ]
});
