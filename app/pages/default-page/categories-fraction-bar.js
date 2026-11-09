// Segments follow the viewport and filters in the order of categories over the whole line
export const categoriesFractionBars = {
    view: 'update-on-line-metrics-changes',
    metrics: '=scopeBreakdown().populationViewport',
    debounce: true,
    content: {
        view: 'fractions-bar',
        data: `
            $breakdown: scopeBreakdown();
            $values: $breakdown.categories.dimensionSampleTotals($breakdown.populationViewport);
            $total: $values.sum(=> value);

            $breakdown.categories.all.dict.entries.[selfValue].sort(selfValue desc).({
                $entry: entry;

                text: $entry.name,
                color: $entry.name.color(),
                value: $values[=> entry = $entry].value,
                $total
            })`,
        tooltip: {
            view: 'labeled-value-list',
            value: 'metric',
            kind: 'grid'
        },
        segment: {
            // formatValue: '==> unit()'
            // tooltip: [
            //     'text:text',
            //     'metric:{ value, total }'
            // ]
        }
    }
};
