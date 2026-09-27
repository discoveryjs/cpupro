import { allPageHeader, allPageTable } from './all-page-common.js';

const compilationTable = {
    view: 'context',
    data: `
        $owners: #.allocationLine | $ ? lineAttribute("allocationOwner");
        $stageFilter: #.allocationLine | $ ? filters.attributeFilters()[=>key = "allocationCompilationStage"];
        $totals: $owners and #.allocationPopulation ? $owners.attributeSampleTotals(#.allocationPopulation) : [];
        (scopeProfile().thread.compilations or [])
            .[no $stageFilter or $stageFilter.filterOptionEnabled(name)]
            .group(=>scriptId + ":" + start)
            .({ subject: key, scriptId: value[0].scriptId, start: value[0].start, callFrame: value[0].callFrame, records: value, events: value.size() })
            .zip(=>subject, $totals.[entry], =>entry.scriptId + ":" + entry.start)
            .({ ...left, count: right.count or 0, size: right.size or 0 })
            .[(callFrame.name or records.functionName or "Unresolved") ~= #.filter]
    `,
    content: [
        allPageTable({
            data: 'sort(size desc, events desc)',
            emptyText: 'No compilation events',
            cols: [
                {
                    header: 'Allocated', sorting: 'size desc', align: 'right',
                    colWhen: '#.allocationPopulation',
                    content: 'text-with-unit{ value: size.bytes(), unit: true }',
                    detailsWhen: 'size',
                    details: {
                        view: 'allocation-samples-matrix',
                        context: '{ ...#, scopeLine: #.allocationLine }',
                        data: `
                            $scriptId: scriptId;
                            $start: start;
                            #.allocationLine.lineAttribute("allocationOwner")
                            .allocationsMatrix(#.allocationPopulation, => $ and $.scriptId = $scriptId and $.start = $start, scopeProfile())
                        `
                    }
                },
                {
                    header: 'Allocation samples', sorting: 'count desc',
                    colWhen: '#.allocationPopulation', content: 'text-numeric:count'
                },
                {
                    header: 'Events', sorting: 'events desc', content: 'text-numeric:events',
                    details: {
                        view: 'table', data: 'records',
                        cols: [
                            { header: 'Stage', content: 'text:name' },
                            { header: 'Timestamp (us)', content: 'text-numeric:tm' },
                            { header: 'Duration (us)', content: 'text-numeric:duration' },
                            { header: 'Line', content: 'text-numeric:line' },
                            { header: 'Column', content: 'text-numeric:column' },
                            {
                                header: 'Source event', content: 'text:eventIndex', detailsWhen: 'event',
                                details: 'struct:event'
                            }
                        ]
                    }
                },
                { header: 'Function', sorting: 'callFrame.name ascN', content: {
                    view: 'switch', content: [
                        { when: 'callFrame', content: 'badge:callFrame.marker() | { text: title, href }' },
                        { content: 'text:"Unresolved"' }
                    ]
                } },
                {
                    header: 'Source', sorting: 'callFrame.end - callFrame.start desc',
                    content: 'text-with-unit{ value: callFrame and callFrame.hasSource() ? (callFrame.end - callFrame.start).bytes() : "", unit: true }',
                    detailsWhen: 'callFrame and callFrame.hasSource()',
                    details: 'call-frame-source:callFrame'
                },
                { header: 'Module', sorting: 'callFrame.module.name ascN', content: { view: 'module-badge', when: 'callFrame', data: 'callFrame.module' } }
            ]
        }),
        {
            view: 'block',
            className: 'all-page-summary',
            content: [
                { view: 'block', content: ['text:"Functions:"', 'text-numeric:size()'] },
                {
                    view: 'block', when: '#.allocationPopulation',
                    content: ['text:"Allocated:"', 'text-with-unit{ value: (sum(=>size) or 0).bytes(), unit: true }']
                }
            ]
        }
    ]
};

discovery.page.define('compilations', {
    view: 'context',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    modifiers: [
        allPageHeader([
            'h1:"Compilations"',
            { view: 'input', name: 'filter', type: 'regexp', placeholder: 'Filter functions' },
            {
                view: 'expand',
                when: 'scopeLine("memline") | $ ? lineAttribute("allocationCompilationStage")',
                header: 'text:"Compilation stages"',
                content: {
                    view: 'update-on-line-metrics-changes',
                    metrics: '=scopeLine("memline").filters',
                    content: {
                        view: 'context',
                        context: '{ ...#, attributeFilter: scopeLine("memline").filters.attributeFilters()[=>key = "allocationCompilationStage"] }',
                        data: '#.attributeFilter',
                        content: [
                            {
                                view: 'list', data: 'options.[key != "none"]',
                                item: {
                                    view: 'checkbox',
                                    checked: '=#.attributeFilter.filterOptionEnabled(key)',
                                    content: 'text:label',
                                    onChange: '=$filter: #.attributeFilter; $key: key; => $filter.setFilterOption($key, $)'
                                }
                            },
                            { view: 'button', text: 'All', onClick: '=$filter: #.attributeFilter; => $filter.allowAllFilter()' }
                        ]
                    }
                }
            }
        ])
    ],
    content: {
        view: 'context',
        context: `{
            ...#,
            allocationLine: scopeLine("memline"),
            allocationPopulation: scopeLine("memline") | $ and lineAttribute("allocationOwner") ? primaryBreakdown().populationFiltered
        }`,
        content: {
            view: 'switch',
            content: [
                {
                    when: '#.allocationLine',
                    content: {
                        view: 'update-on-line-metrics-changes',
                        metrics: '=#.allocationLine.filters',
                        content: {
                            view: 'switch',
                            content: [
                                {
                                    when: '#.allocationPopulation',
                                    content: {
                                        view: 'update-on-line-metrics-changes',
                                        metrics: '=#.allocationPopulation',
                                        content: compilationTable
                                    }
                                },
                                { content: compilationTable }
                            ]
                        }
                    }
                },
                { content: compilationTable }
            ]
        }
    }
});
