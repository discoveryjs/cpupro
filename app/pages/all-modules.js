discovery.page.define('modules', [
    {
        view: 'page-header',
        prelude: [
            'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
            'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
            'badge{ text: "Functions", className: #.page = "functions" ? "selected", href: #.page != "functions" ? "#functions" }'
        ],
        content: 'h1:"All modules"'
    },

    {
        view: 'content-filter',
        data: `
            modulesTimings.entries.zip(=> entry, scripts, => module)
                .({
                    ...,
                    name: left.entry | packageRelPath or name,
                    packageName: left.entry.package.name,
                    categoryName: left.entry.category.name
                })
        `,
        content: [
            {
                view: 'table',
                data: `
                    .[name ~= #.filter]
                    .sort(left.selfTime desc, left.totalTime desc)
                `,
                cols: [
                    { header: 'Self time',
                        data: 'left',
                        colSpan: '=totalTime ? 1 : 3',
                        sorting: 'left.selfTime desc, left.totalTime desc',
                        content: {
                            view: 'switch',
                            content: [
                                { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                { content: 'no-samples' }
                            ]
                        }
                    },
                    { header: 'Nested time',
                        data: 'left',
                        when: 'left.totalTime',
                        sorting: 'left.nestedTime desc, left.totalTime desc',
                        content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
                    },
                    { header: 'Total time',
                        data: 'left',
                        when: 'left.totalTime',
                        sorting: 'left.totalTime desc, left.selfTime desc',
                        content: 'duration:{ time: totalTime, total: #.data.totalTime }'
                    },
                    { header: 'Category',
                        className: 'number',
                        data: 'left.entry.category',
                        sorting: 'categoryName ascN',
                        content: 'badge{ className: "category-badge", text: name, href: marker().href, color: name.color() }'
                    },
                    { header: 'Package',
                        sorting: 'packageName ascN',
                        content: 'package-badge:left.entry.package'
                    },
                    { header: 'Module',
                        sorting: 'name ascN',
                        content: {
                            view: 'badge',
                            data: '{ text: name, href: left.entry.marker().href, match: #.filter }',
                            content: 'text-match'
                        }
                    }
                ]
            }
        ]
    }
]);
