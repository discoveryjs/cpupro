discovery.page.define('owners', [
    {
        view: 'context',
        data: 'scopeTree().owners.filtered.dict.entries',
        modifiers: [
            {
                view: 'page-header',
                className: 'all-page-header',
                content: [
                    'h1:"All owners"',
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
                        { header: 'Owner',
                            data: 'entry',
                            sorting: 'entry.name ascN',
                            content: 'badge{ text: name, href: marker().href }'
                        }
                    ]
                },

                {
                    view: 'block',
                    className: 'app-page-summary',
                    content: [
                        { view: 'block', content: ['text:"Owners:"', 'text-numeric:size()'] },
                        { view: 'block', content: ['text:`${"totalValue".metricName()}:`', 'metric:sum(=>selfValue)'] }
                    ]
                }
            ]
        }
    }
]);
