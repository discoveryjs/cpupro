import { allPageHeader, allPageSummary, allPageTable } from './all-page-common.js';
import { valueCols } from './common.js';

discovery.page.define('owners', [
    {
        view: 'context',
        data: 'scopeBreakdown().owners.filtered.dict.entries',
        modifiers: [
            allPageHeader([
                'h1:"All owners"',
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
                        { header: 'Owner',
                            data: 'entry',
                            sorting: 'entry.name ascN',
                            content: 'badge{ text: name, href: marker().href }'
                        }
                    ]
                }),

                allPageSummary('text:"Owners:"')
            ]
        }
    }
]);
