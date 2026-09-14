import { PopulationFilter, SetAttributeFilter, type AttributeFilter } from '../prepare/computations/population-filter.js';

export const assertions = {
    setAttributeFilter(value: unknown) {
        return value instanceof SetAttributeFilter;
    }
};

export const methods = {
    attributeFilters(filter: PopulationFilter) {
        return filter.filters;
    },
    filterOptionEnabled(filter: SetAttributeFilter, key: string) {
        return filter.isEnabled(key);
    },
    setFilterOption(filter: SetAttributeFilter, key: string, enabled: boolean) {
        filter.setEnabled(key, enabled);
        return filter;
    },
    resetFilter(filter: AttributeFilter | PopulationFilter) {
        filter.reset();
        return filter;
    }
};
