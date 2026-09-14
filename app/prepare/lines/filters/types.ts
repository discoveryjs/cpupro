import type { SetAttributeFilter, Acceptance, PreparedAttributeFilter } from '../../computations/attribute-filter.js';

export type FilterComputation = {
    settings: SetAttributeFilter;
    domain: PreparedAttributeFilter['domain'];
    size: number;
    compile(settings: SetAttributeFilter): Acceptance;
};
