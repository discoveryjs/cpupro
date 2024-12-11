discovery.page.define('modules', [
    {
        view: 'context',
        data: `
            currentProfile
            | modulesTimings.entries.zip(=> entry, scripts, => module)
                .({
                    $entry: left.entry;

                    ...,
                    $entry,
                    name: $entry | packageRelPath or name,
                    nameWithPackageName: $entry | \`\${package.name}/\${packageRelPath or name}\`,
                    packageName: $entry.package.name,
                    categoryName: $entry.category.name,
                    selfTime: left.selfTime,
                    nestedTime: left.nestedTime,
                    totalTime: left.totalTime
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
                    data: '.sort(selfTime desc, totalTime desc)',
                    cols: [
                        { header: 'Self time',
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
                        { header: 'Nested time',
                            className: 'timings',
                            when: 'totalTime',
                            sorting: 'nestedTime desc, totalTime desc',
                            contentWhen: 'nestedTime',
                            content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                        },
                        { header: 'Total time',
                            className: 'timings',
                            when: 'totalTime',
                            sorting: 'totalTime desc, selfTime desc',
                            content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                        },
                        { header: 'Category',
                            className: 'number',
                            data: 'entry.category',
                            sorting: 'categoryName ascN',
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
                        { view: 'block', content: ['text:"Total time:"', 'duration:{ time: sum(=>selfTime), total: #.data.totalTime }'] }
                    ]
                }
            ]
        }
    }
]);
