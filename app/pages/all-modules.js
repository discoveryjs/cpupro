import { allPageHeader, allPageSummary, allPageTable } from './all-page-common.js';
import { valueCols } from './common.js';

discovery.page.define('modules', [
    {
        view: 'context',
        data: `
            scopeBreakdown() | modules.all.dict.entries
                .zip(=> entry, line.profile.scripts, => module)
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
            allPageHeader([
                'h1:"All modules"',
                {
                    view: 'input',
                    name: 'filter',
                    type: 'regexp',
                    placeholder: 'Filter'
                }
            ])
        ],
        content: {
            view: 'context',
            data: '.[name ~= #.filter or nameWithPackageName ~= #.filter]',
            content: [
                allPageTable({
                    cols: [
                        ...valueCols,
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
                }),

                allPageSummary('text:"Modules:"')
            ]
        }
    }
]);
