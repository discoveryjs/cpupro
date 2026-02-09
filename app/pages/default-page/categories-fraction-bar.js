export const categoriesFractionBars = {
    view: 'fractions-bar',
    data: `
        $values: scopeLine().dict.categories.all.entries.[selfValue];
        $total: $values.sum(=> selfValue);

        $values.({
            text: entry.name,
            color: entry.name.color(),
            value: selfValue,
            $total
        }).sort(value desc)`,
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
};
