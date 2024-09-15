discovery.page.define('packages', [
    {
        view: 'page-header',
        prelude: [
            'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
            'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
            'badge{ text: "Functions", className: #.page = "functions" ? "selected", href: #.page != "functions" ? "#functions" }'
        ],
        content: 'h1:"All packages"'
    },

    {
        view: 'content-filter',
        data: 'packagesTimings.entries',
        content: [
            {
                view: 'table',
                data: `
                    .[entry.name ~= #.filter]
                    .sort(selfTime desc, totalTime desc)
                `,
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
            }
        ]
    }
]);
