import { SetAttributeFilter, type AttributeFilterSettings } from '../prepare/computations/attribute-filter.js';
import type { Population, PopulationFiltered } from '../prepare/computations/population.js';
import type { ProfileLineBreakdown } from '../prepare/lines/types.js';

function aggregateFilterOptions(
    breakdown: ProfileLineBreakdown,
    filter: SetAttributeFilter,
    population: Population | PopulationFiltered,
    metric: 'samplesCount' | 'samplesTotal'
) {
    const totals = new Map(filter.options.map(option => [option.key, 0]));
    const { source, line } = breakdown;

    if (filter.key === 'category') {
        const values = population[metric];
        const { dictionary, nodes, sourceIdToNode } = source;

        for (let sampleId = 0; sampleId < values.length; sampleId++) {
            const value = values[sampleId];

            if (value === 0) {
                continue;
            }

            const entry = dictionary[nodes[sourceIdToNode[sampleId]]];
            const callFrame = 'callFrame' in entry ? entry.callFrame : entry;
            const key = callFrame.category.name;

            totals.set(key, (totals.get(key) || 0) + value);
        }

        return totals;
    }

    const attributeName = filter.key === 'allocationLiveness' ? 'allocationLifespan' : filter.key;
    const attribute = line.attributes.find(attribute => attribute.name === attributeName);

    if (!attribute) {
        return totals;
    }

    const values = population.aggregateBy(attribute.values, attribute.dict.length)[metric];

    for (let index = 0; index < values.length; index++) {
        let key: string;

        switch (attribute.name) {
            case 'allocationSpace':
                key = attribute.dict[index].code;
                break;
            case 'allocationLifespan':
                key = index === 0 ? 'alive' : 'gced';
                break;
            case 'allocationCompilationStage':
                key = attribute.dict[index];
                break;
            default:
                continue;
        }

        totals.set(key, (totals.get(key) || 0) + values[index]);
    }

    return totals;
}

export function filterOptionTotals(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    return aggregateFilterOptions(breakdown, filter, breakdown.populationViewport, 'samplesTotal');
}

export function filterOptions(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    const counts = aggregateFilterOptions(breakdown, filter, breakdown.population, 'samplesCount');

    return filter.options.filter(option => counts.get(option.key)! > 0);
}

export const assertions = {
    setAttributeFilter(value: unknown) {
        return value instanceof SetAttributeFilter;
    }
};

export const methods = {
    filterOptions,
    filterOptionTotals,
    attributeFilters(filter: { filters: AttributeFilterSettings[] }) {
        return filter.filters;
    },
    filterActive(filter: AttributeFilterSettings) {
        return filter.active;
    },
    filterOptionEnabled(filter: SetAttributeFilter, key: string) {
        return filter.isEnabled(key);
    },
    setFilterOption(filter: SetAttributeFilter, key: string, enabled: boolean) {
        filter.setEnabled(key, enabled);
        return filter;
    },
    setFilterSelection(filter: SetAttributeFilter, mode: 'include' | 'exclude', keys: string[]) {
        filter.setSelection(mode, keys);
        return filter;
    },
    resetFilter(filter: { reset(): void }) {
        filter.reset();
        return filter;
    },
    allowAllFilter(filter: { allowAll(): void }) {
        filter.allowAll();
        return filter;
    }
};
