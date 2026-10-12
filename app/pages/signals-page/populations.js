function density(type) {
    const cpu = type === 'timeline';

    return {
        view: 'context',
        context: '{ ...#, densityLength: end - start, countMax: bins.max() or 1, valueMax: valueBins.max() or 1 }',
        modifiers: [
            {
                view: 'select', name: 'category', value: '"all"',
                data: '["all"] + categories.[total]',
                text: '$ = "all" ? "All categories" : category.name ?? "Unknown"'
            },
            {
                view: 'toggle-group', name: 'quantity', value: cpu ? 'count' : 'value',
                data: [
                    { text: 'Count', value: 'count' },
                    { text: cpu ? 'Interval sum (us)' : 'Bytes', value: 'value' }
                ]
            }
        ],
        content: {
            view: 'block', className: 'signal-density',
            data: '#.category = "all" ? $ : #.category',
            content: [
                {
                    view: 'line-ruler', range: '=#.densityLength', segments: '=bins.size()',
                    labels: 'top',
                    ...(cpu ? {} : { formatLabel: value => Math.round(value).toLocaleString('en-US', { notation: 'compact' }) }),
                    details: [
                        'text:`Count: ${bins[#.segmentStart:#.segmentEnd + 1].sum() or 0}`',
                        {
                            view: 'text',
                            data: `" / ${cpu ? 'Interval sum (us)' : 'Bytes'}: " +
                                (valueBins[#.segmentStart:#.segmentEnd + 1].sum() or 0)`
                        }
                    ]
                },
                {
                    view: 'bins-histogram',
                    bins: '=#.quantity = "value" ? valueBins : bins',
                    max: '=#.quantity = "value" ? #.valueMax : #.countMax',
                    height: 100, color: '#629cbaa0'
                },
                {
                    view: 'labeled-value-list',
                    data: `[
                        { text: 'Count', value: bins.sum() or 0 },
                        { text: '${cpu ? 'Interval sum (us)' : 'Bytes'}', value: valueBins.sum() or 0 }
                    ]`,
                    value: 'text-numeric:value'
                }
            ]
        }
    };
}

export function samplePopulation(type) {
    const cpu = type === 'timeline';
    const valueTitle = cpu ? 'Interval sum (us)' : 'Bytes';
    const fractions = [
        {
            header: 'Count', align: 'right',
            content: 'value-fraction{ value: total, total: #.populationCount }'
        },
        {
            header: valueTitle, align: 'right',
            content: {
                view: 'switch',
                content: [
                    {
                        when: '#.populationValue > 0',
                        content: 'value-fraction{ value, total: #.populationValue }'
                    },
                    { content: 'text-numeric:value' }
                ]
            }
        }
    ];

    return {
        view: 'section', when: type,
        header: `text:"${cpu ? 'CPU samples' : 'Allocations'}"`,
        content: {
            view: 'context',
            context: `{ ...#, scopeLine: $.${type} }`,
            data: `sampleDistribution('${type}')`,
            content: {
                view: 'context',
                context: '{ ...#, populationCount: count, populationValue: value }',
                content: [
                    {
                        view: 'table', className: 'signal-categories',
                        data: 'categories.[total].sort(value desc)',
                        cols: [
                            {
                                header: 'Category',
                                content: 'text:category.name ?? "Unknown"'
                            },
                            ...fractions
                        ]
                    },
                    {
                        view: 'section',
                        header: `text:"${cpu ? 'Sample starts over time from first sample' : 'Allocations over sample index'}"`,
                        content: density(type)
                    },
                    {
                        view: 'expand',
                        header: `text:"${cpu ? 'Sample intervals' : 'Allocation sizes'}"`,
                        content: {
                            view: 'table', className: 'signal-sizes',
                            data: 'sizes.[count].({ ..., total: count })',
                            cols: [
                                { header: cpu ? 'Interval (us)' : 'Size (bytes)', content: 'text:`${min} <= value < ${max}`' },
                                ...fractions
                            ]
                        }
                    }
                ]
            }
        }
    };
}
