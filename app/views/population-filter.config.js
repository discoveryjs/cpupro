export const populationFilter = {
    view: 'population-filter',
    data: 'scopeBreakdown()',
    filters: '=line.filters.attributeFilters().[is setAttributeFilter]',
    options: '=$breakdown: $; => $breakdown.filterOptions($)',
    optionTotals: '=$breakdown: $; => $breakdown.filterOptionTotals($)',
    onReset: '=$filter: line.filters; => $filter.allowAllFilter()',
    group: {
        view: 'context',
        context: '{ ...#, attributeFilter: filter }',
        content: {
            view: 'list',
            className: 'population-filter__options',
            limit: false,
            data: 'options',
            itemConfig: { view: 'population-filter-option' },
            item: [
                {
                    view: 'checkbox',
                    checked: '=#.attributeFilter.filterOptionEnabled(key)',
                    content: 'text:label',
                    onChange: '=$filter: #.attributeFilter; $key; => $filter.setFilterOption($key, $)'
                },
                {
                    view: 'button',
                    className: 'population-filter__only',
                    text: 'Only',
                    onClick: '=$filter: #.attributeFilter; $key; => $filter.setFilterSelection("include", [$key])'
                },
                {
                    view: 'block',
                    className: 'population-filter__metrics',
                    content: [
                        { view: 'text-numeric', className: 'population-filter__total', text: '=total.formatValue()' },
                        { view: 'text-numeric', className: 'population-filter__percent', text: '=percent' }
                    ]
                }
            ]
        }
    },
    resetAttribute: {
        view: 'button',
        text: 'All',
        onClick: '=$filter: $; => $filter.allowAllFilter()'
    },
    summary: {
        view: 'update-on-line-metrics-changes',
        metrics: '=populationViewport',
        content: {
            view: 'block',
            className: 'population-filter__summary',
            data: '{ included: populationViewport.samplesTotal.sum(), excluded: populationViewport.sink.total }',
            content: [
                {
                    view: 'block',
                    content: [
                        { view: 'block', content: 'text:"Included:"' },
                        { view: 'block', content: 'text-numeric:included.formatValue()' }
                    ]
                },
                {
                    view: 'block',
                    when: 'excluded > 0',
                    content: [
                        { view: 'block', content: 'text:"Excluded:"' },
                        { view: 'block', content: 'text-numeric:excluded.formatValue()' },
                        {
                            view: 'button',
                            className: 'population-filter__reset',
                            text: 'Reset all',
                            onClick: '=#.resetPopulationFilter'
                        }
                    ]
                }
            ]
        }
    }
};
