export const populationFilter = {
    view: 'update-on-line-metrics-changes',
    data: 'scopeBreakdown()',
    metrics: '=populationFiltered.filter',
    content: {
        view: 'block',
        className: 'population-filter',
        content: [
            {
                view: 'list',
                className: 'population-filter__attributes',
                data: 'populationFiltered.filter.attributeFilters().[is setAttributeFilter]',
                item: {
                    view: 'context',
                    context: '{ ...#, attributeFilter: $ }',
                    content: {
                        view: 'block',
                        className: 'population-filter__attribute',
                        content: [
                            'text:label',
                            {
                                view: 'list',
                                className: 'population-filter__options',
                                data: 'options',
                                item: {
                                    view: 'checkbox',
                                    checked: '=#.attributeFilter.filterOptionEnabled(key)',
                                    content: 'badge{ text: label, color: color }',
                                    onChange: '=$filter: #.attributeFilter; $key: key; => $filter.setFilterOption($key, $)'
                                }
                            },
                            {
                                view: 'button',
                                text: 'All',
                                onClick: '=$filter: #.attributeFilter; => $filter.resetFilter()'
                            }
                        ]
                    }
                }
            },
            {
                view: 'button',
                text: 'Reset filters',
                onClick: '=$filter: populationFiltered.filter; => $filter.resetFilter()'
            },
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=populationFiltered',
                content: {
                    view: 'block',
                    className: 'population-filter__summary',
                    data: '{ included: populationFiltered.samplesTotal.sum(), excluded: populationFiltered.sink.total }',
                    content: [
                        'text:`Included: ${included.formatValue()}`',
                        'text:`Excluded: ${excluded.formatValue()}`'
                    ]
                }
            }
        ]
    }
};
