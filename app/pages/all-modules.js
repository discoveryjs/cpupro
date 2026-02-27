discovery.page.define('modules', [
    {
        view: 'context',
        data: `
            scopeLine() | dict.modules.all.entries
                .zip(=> entry, profile.scripts, => module)
                .({
                    $entry: left.entry;

                    ...,
                    $entry,
                    name: $entry | packageRelPath or name,
                    nameWithPackageName: $entry | \`\${package.name}/\${packageRelPath or name}\`,
                    packageName: $entry.package.name,
                    categoryName: $entry.category.name,
                    selfValue: left.selfValue,
                    nestedValue: left.nestedValue,
                    totalValue: left.totalValue
                })
        `,
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
                    'h1:"All modules"',
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
            data: '.[name ~= #.filter or nameWithPackageName ~= #.filter]',
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
                            sorting: 'categoryName ascN',
                            data: 'entry.category',
                            align: 'right',
                            content: 'badge{ className: "category-badge", text: name, href: marker().href, color: name.color() }'
                        },
                        { header: 'Package',
                            sorting: 'packageName ascN',
                            content: 'package-badge:entry.package'
                        },
                        { header: 'Module',
                            sorting: 'name ascN',
                            content: {
                                view: 'badge',
                                data: '{ text: name, href: entry.marker().href, match: #.filter }',
                                content: 'text-match'
                            }
                        }
                    ]
                },

                {
                    view: 'block',
                    className: 'app-page-summary',
                    content: [
                        { view: 'block', content: ['text:"Modules:"', 'text-numeric:size()'] },
                        { view: 'block', content: ['text:`${"totalValue".metricName()}:`', 'metric:sum(=>selfValue)'] }
                    ]
                }
            ]
        }
    }
]);
