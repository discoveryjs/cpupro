discovery.page.define('packages', [
    {
        view: 'context',
        data: 'currentProfile.packagesTimings.entries',
        modifiers: [
            {
                view: 'page-header',
                className: 'all-page-header',
                prelude: [
                    'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
                    'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
                    'badge{ text: "Call frames", className: #.page = "call-frames" ? "selected", href: #.page != "call-frames" ? "#call-frames" }'
                ],
                content: [
                    'h1:"All packages"',
                    {
                        view: 'input',
                        name: 'filter',
                        type: 'regexp',
                        placeholder: 'Filter'
                    }
                ]
            }
        ],
        content: {
            view: 'context',
            data: '.[entry.name ~= #.filter]',
            content: [
                {
                    view: 'table',
                    className: 'all-page-table',
                    limit: 50,
                    data: '.sort(selfTime desc, totalTime desc)',
                    cols: [
                        { header: { className: 'timings', text: 'Self time' },
                            className: 'timings',
                            colSpan: '=totalTime ? 1 : 3',
                            sorting: 'selfTime desc, totalTime desc',
                            contentWhen: 'selfTime or no totalTime',
                            content: {
                                view: 'switch',
                                content: [
                                    { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                    { content: 'no-samples' }
                                ]
                            }
                        },
                        { header: { className: 'timings', text: 'Nested time' },
                            className: 'timings',
                            when: 'totalTime',
                            sorting: 'nestedTime desc, totalTime desc',
                            contentWhen: 'nestedTime',
                            content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                        },
                        { header: { className: 'timings', text: 'Total time' },
                            className: 'timings',
                            when: 'totalTime',
                            sorting: 'totalTime desc, selfTime desc',
                            content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                        },
                        { header: { className: 'category', text: 'Category' },
                            sorting: 'entry.category.name ascN',
                            data: 'entry.category',
                            align: 'right',
                            content: 'badge{ className: "category-badge", text: name, href: marker().href, color: name.color() }'
                        },
                        { header: 'Package',
                            data: 'entry',
                            sorting: 'entry.name ascN',
                            content: 'package-badge'
                        }
                    ]
                },

                {
                    view: 'block',
                    className: 'app-page-summary',
                    content: [
                        { view: 'block', content: ['text:"Packages:"', 'text-numeric:size()'] },
                        { view: 'block', content: ['text:"Total time:"', 'duration:{ time: sum(=>selfTime), total: #.data.totalTime }'] }
                    ]
                }
            ]
        }
    }
]);
