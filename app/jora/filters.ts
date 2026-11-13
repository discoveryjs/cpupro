import { SetAttributeFilter, type AttributeFilterSettings } from '../prepare/computations/attribute-filter.js';
import type { ProfileLineAttribute, ProfileLineBreakdown } from '../prepare/lines/types.js';
import { aggregateAttribute } from '../prepare/lines/memline-attributes.mjs';

// Totals of the options of a filter: categories from per-sample totals, attribute values from totals by value
function aggregateFilterOptions(
    breakdown: ProfileLineBreakdown,
    filter: SetAttributeFilter,
    sampleTotals: ArrayLike<number>,
    attributeTotals: (attribute: ProfileLineAttribute) => ArrayLike<number>
) {
    const totals = new Map(filter.options.map(option => [option.key, 0]));
    const { source, line } = breakdown;

    if (filter.key === 'category') {
        const { dictionary, nodes, sourceIdToNode } = source;

        for (let i = 0; i < sampleTotals.length; i++) {
            const value = sampleTotals[i];

            if (value === 0) {
                continue;
            }

            const entry = dictionary[nodes[sourceIdToNode[i]]];
            const callFrame = 'callFrame' in entry ? entry.callFrame : entry;
            const key = callFrame.category.name;

            totals.set(key, (totals.get(key) || 0) + value);
        }

        return totals;
    }

    const attribute = line.attributes.find(attribute => attribute.name === filter.key);

    if (!attribute) {
        return totals;
    }

    // Options of an attribute filter follow the attribute's dictionary
    const values = attributeTotals(attribute);

    for (let i = 0; i < filter.options.length; i++) {
        totals.set(filter.options[i].key, values[i]);
    }

    return totals;
}

export function filterOptionTotals(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    const { populationViewport } = breakdown;
    const attributeTotals = (attribute: ProfileLineAttribute) =>
        aggregateAttribute(populationViewport, attribute).samplesTotal;

    return aggregateFilterOptions(
        breakdown,
        filter,
        populationViewport.samplesTotal,
        attributeTotals
    );
}

// Options present in the line: totals count events of nonzero values only, so an option with events has a total
export function filterOptions(breakdown: ProfileLineBreakdown, filter: SetAttributeFilter) {
    const { population } = breakdown;
    const attributeTotals = (attribute: ProfileLineAttribute) =>
        aggregateAttribute(population, attribute).samplesTotal;
    const totals = aggregateFilterOptions(
        breakdown,
        filter,
        population.samplesTotal,
        attributeTotals
    );

    return filter.options.filter(option => totals.get(option.key)! > 0);
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
