import { SetAttributeFilter, type AttributeFilterSettings } from '../prepare/computations/attribute-filter.js';

export const assertions = {
    setAttributeFilter(value: unknown) {
        return value instanceof SetAttributeFilter;
    }
};

export const methods = {
    attributeFilters(filter: { filters: AttributeFilterSettings[] }) {
        return filter.filters;
    },
    filterOptionEnabled(filter: SetAttributeFilter, key: string) {
        return filter.isEnabled(key);
    },
    setFilterOption(filter: SetAttributeFilter, key: string, enabled: boolean) {
        filter.setEnabled(key, enabled);
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
