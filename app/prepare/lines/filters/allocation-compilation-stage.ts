import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import type { ProfileLineAttribute } from '../types.js';
import type { FilterComputation } from './types.js';

export function createAllocationCompilationStageFilter(attribute: ProfileLineAttribute, eventCount: number): FilterComputation | null {
    if (attribute.name !== 'allocationCompilationStage' || attribute.values.length !== eventCount) {
        return null;
    }

    const { values, dict } = attribute;
    const options = dict.map(name => ({ key: name, label: name }));

    return {
        settings: new SetAttributeFilter('allocationCompilationStage', 'Compilation stage', options),
        domain: 'event',
        size: eventCount,
        values,
        compile(settings) {
            return Uint8Array.from(dict, name => settings.isEnabled(name) ? 1 : 0);
        }
    };
}
