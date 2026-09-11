const CATEGORY_FILTER_BIT = 1;

export function getCategoryOptions(breakdown) {
    const dimension = breakdown.categories;
    if (!dimension) {
        return [];
    }

    const { tree, sampleToNode } = dimension;
    const population = breakdown.populationFiltered;
    const categories = new Map();

    for (let sampleId = 0; sampleId < population.samplesMask.length; sampleId++) {
        if (breakdown.population.samplesCount[sampleId] === 0) {
            continue;
        }
        const category = tree.dictionary[tree.nodes[sampleToNode[sampleId]]];
        let option = categories.get(category);
        if (!option) {
            option = { category, breakdown, checked: true };
            categories.set(category, option);
        }
        if (population.samplesMask[sampleId] & CATEGORY_FILTER_BIT) {
            option.checked = false;
        }
    }

    return [...categories.values()];
}

export function setCategoryEnabled(breakdown, category, enabled) {
    const { tree, sampleToNode } = breakdown.categories;
    breakdown.populationFiltered.updateMask(mask => {
        for (let sampleId = 0; sampleId < mask.length; sampleId++) {
            if (tree.dictionary[tree.nodes[sampleToNode[sampleId]]] === category) {
                mask[sampleId] = enabled
                    ? mask[sampleId] & ~CATEGORY_FILTER_BIT
                    : mask[sampleId] | CATEGORY_FILTER_BIT;
            }
        }
    });
}

export function resetCategoryFilter(breakdown) {
    breakdown.populationFiltered.updateMask(mask => {
        for (let sampleId = 0; sampleId < mask.length; sampleId++) {
            mask[sampleId] &= ~CATEGORY_FILTER_BIT;
        }
    });
}

export const populationFilter = {
    view: 'update-on-line-metrics-changes',
    data: 'scopeBreakdown()',
    metrics: '=populationFiltered',
    content: {
        view: 'block',
        className: 'population-filter',
        content: [
            'text:"Categories"',
            {
                view: 'list',
                className: 'population-filter__categories',
                data: getCategoryOptions,
                item: {
                    view: 'checkbox',
                    checked: '=checked',
                    content: 'badge{ text: category.name, color: category.name.color() }',
                    onChange: (checked, name, { breakdown, category }) =>
                        setCategoryEnabled(breakdown, category, checked)
                }
            },
            {
                view: 'button',
                text: 'All categories',
                onClick: (event, breakdown) => resetCategoryFilter(breakdown)
            },
            {
                view: 'block',
                className: 'population-filter__summary',
                data: `{
                    included: populationFiltered.samplesTotal.sum(),
                    excluded: populationFiltered.sink.total
                }`,
                content: [
                    'text:`Included: ${included.formatValue()}`',
                    'text:`Excluded: ${excluded.formatValue()}`'
                ]
            }
        ]
    }
};
