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
        item: 'labeled-value{ value: "metric:{ value, total }" }'
    },
    segment: {
        // formatValue: '==> unit()'
        // tooltip: [
        //     'text:text',
        //     'metric:{ value, total }'
        // ]
    }
};
