import { allPageHeader, allPageSummary, allPageTable } from './all-page-common.js';
import { valueCols } from './common.js';

discovery.page.define('packages', [
    {
        view: 'context',
        data: 'scopeBreakdown().packages.all.dict.entries',
        modifiers: [
            allPageHeader([
                'h1:"All packages"',
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
            data: '.[entry.name ~= #.filter]',
            content: [
                allPageTable({
                    cols: [
                        ...valueCols,
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
                }),

                allPageSummary('text:"Packages:"')
            ]
        }
    }
]);
