import { allPageHeader, allPageTable } from './all-page-common.js';

const compilationTable = {
    view: 'context',
    data: `
        $stageFilter: #.allocationLine | $ ? filters.attributeFilters()[=>key = "allocationCompilationStage"];
        $totals: #.allocationLine | $ ? lineAttribute("allocationOwner")
            | $ and #.allocationPopulation ? attributeSampleTotals(#.allocationPopulation) : []
            | group(=>entry).({ entry: key, count: value.sum(=>count), size: value.sum(=>size) });
        scopeProfile().thread.events.[cat = "disabled-by-default-v8.compilation_allocations" and callFrame]
            .[no $stageFilter or $stageFilter.filterOptionEnabled(name)]
            .group(=>callFrame)
            .({ callFrame: key, events: value.size(), selfTime: value.sum(=>selfTime) })
            .zip(=>callFrame, $totals, =>entry)
            .({ ...left, count: right.count or 0, size: right.size or 0 })
            .[callFrame.name ~= #.filter]
    `,
    content: [
        allPageTable({
            data: 'sort(size desc, selfTime desc)',
            emptyText: 'No compilation events',
            cols: [
                {
                    header: 'Allocated', sorting: 'size desc', align: 'right',
                    colWhen: '#.allocationPopulation',
                    content: 'text-with-unit{ value: size.bytes(), unit: true }',
                    detailsWhen: 'size',
                    details: {
                        view: 'allocation-samples-matrix',
                        data: `
                            $owner: callFrame;
                            #.allocationLine.lineAttribute("allocationOwner")
                            .allocationsMatrix(#.allocationPopulation, $owner, scopeProfile())
                        `
                    }
                },
                {
                    header: 'Allocation samples', sorting: 'count desc',
                    colWhen: '#.allocationPopulation', content: 'text-numeric:count'
                },
                {
                    header: 'Event self time (whole profile)', sorting: 'selfTime desc', align: 'right',
                    content: {
                        view: 'text-with-unit', data: 'selfTime.valueAndUnit("timeline")',
                        value: '=value', unit: '=unit'
                    }
                },
                { header: 'Events', sorting: 'events desc', content: 'text-numeric:events' },
                { header: 'Function', sorting: 'callFrame.name ascN', content: 'badge:callFrame.marker() | { text: title, href }' },
                {
                    header: 'Source', sorting: 'callFrame.end - callFrame.start desc',
                    content: 'text-with-unit{ value: callFrame.hasSource() ? (callFrame.end - callFrame.start).bytes() : "", unit: true }',
                    detailsWhen: 'callFrame.hasSource()',
                    details: 'call-frame-source:callFrame'
                },
                { header: 'Module', sorting: 'callFrame.module.name ascN', content: 'module-badge:callFrame.module' }
            ]
        }),
        {
            view: 'block',
            className: 'all-page-summary',
            content: [
                { view: 'block', content: ['text:"Call frames:"', 'text-numeric:size()'] },
                {
                    view: 'block', when: '#.allocationPopulation',
                    content: ['text:"Allocated:"', 'text-with-unit{ value: (sum(=>size) or 0).bytes(), unit: true }']
                },
                { view: 'block', content: ['text:"Event self time:"', 'metric{ line: "timeline", value: sum(=>selfTime) or 0 }'] }
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
                when: 'scopeLine("memline")',
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
            allocationPopulation: scopeLine("memline") | $ ? primaryBreakdown().populationFiltered
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
