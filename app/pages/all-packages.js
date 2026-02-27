discovery.page.define('packages', [
    {
        view: 'context',
        data: 'scopeLine().dict.packages.all.entries',
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
                    data: '.sort(selfValue desc, totalValue desc)',
                    cols: [
                        { header: { className: 'timings', text: '="selfValue".metricName()' },
                            className: 'timings',
                            colSpan: '=totalValue ? 1 : 3',
                            sorting: 'selfValue desc, totalValue desc',
                            contentWhen: 'selfValue or no totalValue',
                            content: {
                                view: 'switch',
                                content: [
                                    { when: 'totalValue', content: 'metric:selfValue' },
                                    { content: 'no-samples' }
                                ]
                            }
                        },
                        { header: { className: 'timings', text: '="nestedValue".metricName()' },
                            className: 'timings',
                            when: 'totalValue',
                            sorting: 'nestedValue desc, totalValue desc',
                            contentWhen: 'nestedValue',
                            content: 'metric:nestedValue'
                        },
                        { header: { className: 'timings', text: '="totalValue".metricName()' },
                            className: 'timings',
                            when: 'totalValue',
                            sorting: 'totalValue desc, selfValue desc',
                            content: 'metric:totalValue'
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
                        { view: 'block', content: ['text:`${"totalValue".metricName()}:`', 'metric:sum(=>selfValue)'] }
                    ]
                }
            ]
        }
    }
]);
