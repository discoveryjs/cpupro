const coveredColor = '#629cbaa0';
const outsideColor = '#ce985ba0';
const coverage = {
    view: 'table',
    data: 'categories.[total]',
    cols: [
        {
            header: 'Category',
            content: 'text:category.name ?? "Unknown"'
        },
        { header: 'Samples', align: 'right', content: 'text-numeric:total' },
        { header: 'Inside', align: 'right', content: 'text-numeric:covered' },
        { header: 'Outside', align: 'right', content: 'value-fraction{ value: outside, total }' },
        {
            header: 'Inside / outside',
            content: {
                view: 'fractions-bar',
                data: `[
                    { text: 'Inside', value: covered, color: '${coveredColor}' },
                    { text: 'Outside', value: outside, color: '${outsideColor}' }
                ]`,
                segment: { formatValue: value => value.toLocaleString('en-US') }
            }
        }
    ]
};

const matrix = {
    view: 'context',
    context: '{ ...#, categories }',
    modifiers: {
        view: 'toggle-group', name: 'denominator', value: 'event',
        data: [
            { text: '% of event samples', value: 'event' },
            { text: '% of category samples', value: 'category' }
        ]
    },
    content: {
        view: 'table', className: 'signal-matrix',
        data: 'events.[count].sort(name != null asc, count desc)', limit: 20,
        cols: `=[
            { header: 'Event / stage', content: 'text:name ?? "Outside events"' },
            { header: 'Samples', align: 'right', content: 'text-numeric:count' }
        ] + #.categories.[total].(
            $categoryIndex: #.categories.indexOf($);
            {
                header: category.name ?? 'Unknown', align: 'right',
                content: {
                    view: 'value-fraction', value: '=counts[' + $categoryIndex + ']',
                    total: '=#.denominator = "category" ? #.categories[' + $categoryIndex + '].total : count'
                }
            }
        )`
    }
};

function density(type) {
    return {
        view: 'context',
        context: '{ ...#, densityLength: end - start, densityMax: bins.max() or 1 }',
        modifiers: {
            view: 'select', name: 'category', value: '"all"',
            data: '["all"] + categories.[total]',
            text: '$ = "all" ? "All categories" : category.name ?? "Unknown"'
        },
        content: {
            view: 'block', className: 'signal-density',
            data: '#.category = "all" ? $ : #.category',
            content: [
                {
                    view: 'line-ruler', range: '=#.densityLength', segments: '=bins.size()',
                    labels: 'top',
                    ...(type === 'memline' ? { formatLabel: value => Math.round(value).toLocaleString('en-US', { notation: 'compact' }) } : {}),
                    details: [
                        'text:`All: ${bins[#.segmentStart:#.segmentEnd + 1].sum() or 0}`',
                        'text:` / Outside: ${outsideBins[#.segmentStart:#.segmentEnd + 1].sum() or 0}`'
                    ]
                },
                {
                    view: 'block', className: 'signal-density-layers',
                    content: [
                        { view: 'bins-histogram', bins: '=bins', max: '=#.densityMax', height: 80, color: '#8885' },
                        {
                            view: 'bins-histogram', bins: '=outsideBins', max: '=#.densityMax',
                            height: 80, color: outsideColor
                        }
                    ]
                },
                {
                    view: 'labeled-value-list',
                    data: `[
                        { text: 'All samples', color: '#8888', value: bins.sum() or 0 },
                        { text: 'Outside events', color: '${outsideColor}',
                          value: outsideBins.sum() or 0 }
                    ]`,
                    value: 'text-numeric:value'
                }
            ]
        }
    };
}

export function correlations(type) {
    const cpu = type === 'timeline';

    return {
        view: 'section',
        header: `text:${JSON.stringify(cpu ? 'CPU samples and events' : 'Allocations and stages')}`,
        content: {
            view: 'context',
            context: `{ ...#, scopeLine: $.${type} }`,
            data: `samplesByCompilation('${type}')`,
            content: {
                view: 'switch',
                content: [
                    {
                        when: 'no $',
                        content: cpu
                            ? 'text:"Unavailable: CPU samples and non-crossing timed events required"'
                            : 'text:"Unavailable: allocation locations and compilation stage required"'
                    },
                    { content: [
                        coverage,
                        {
                            view: 'section',
                            header: `text:${JSON.stringify(cpu
                                ? 'Density over time from first sample'
                                : 'Density over allocation index')}`,
                            content: density(type)
                        },
                        ...(!cpu ? [{
                            view: 'section',
                            header: 'text:"Outside stages: recording boundaries (assuming IDs 1..N)"',
                            content: {
                                view: 'switch', content: [
                                    {
                                        when: 'window',
                                        content: {
                                            view: 'table', data: 'categories.[outside]',
                                            cols: [
                                                { header: 'Category', content: 'text:category.name ?? "Unknown"' },
                                                { header: 'Before CPU', content: 'text-numeric:before' },
                                                {
                                                    header: 'Within CPU window',
                                                    content: 'text-numeric:outside - before - after'
                                                },
                                                { header: 'After CPU', content: 'text-numeric:after' }
                                            ]
                                        }
                                    },
                                    { content: 'text:"CPU allocation boundaries unavailable"' }
                                ]
                            }
                        }] : []),
                        {
                            view: 'expand', expanded: true,
                            header: 'text:"Event / stage by category"', content: matrix
                        }
                    ] }
                ]
            }
        }
    };
}
