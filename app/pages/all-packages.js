discovery.page.define('packages', [
    {
        view: 'context',
        data: 'packagesTimings.entries',
        modifiers: [
            {
                view: 'page-header',
                className: 'all-page-header',
                prelude: [
                    'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
                    'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
                    'badge{ text: "Functions", className: #.page = "functions" ? "selected", href: #.page != "functions" ? "#functions" }'
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
                        { header: 'Self time',
                            colSpan: '=totalTime ? 1 : 3',
                            sorting: 'selfTime desc, totalTime desc',
                            content: {
                                view: 'switch',
                                content: [
                                    { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                    { content: 'no-samples' }
                                ]
                            }
                        },
                        { header: 'Nested time',
                            when: 'totalTime',
                            sorting: 'nestedTime desc, totalTime desc',
                            content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                        },
                        { header: 'Total time',
                            when: 'totalTime',
                            sorting: 'totalTime desc, selfTime desc',
                            content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                        },
                        { header: 'Category',
                            className: 'number',
                            data: 'entry.category',
                            sorting: 'entry.category.name ascN',
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
