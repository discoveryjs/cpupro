import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import type { ProfileLineAttribute } from '../types.js';
import type { FilterComputation } from './types.js';

export function createAllocationLivenessFilter(attribute: ProfileLineAttribute, eventCount: number): FilterComputation | null {
    if (attribute.name !== 'allocationLifespan' || attribute.values.length !== eventCount) {
        return null;
    }

    const { values, dict } = attribute;
    const options = [
        { key: 'alive', label: 'Alive' },
        { key: 'gced', label: 'GCed' }
    ];

    return {
        settings: new SetAttributeFilter('allocationLiveness', 'Allocations', options),
        domain: 'event',
        size: eventCount,
        values,
        compile(settings) {
            const alive = settings.isEnabled('alive') ? 1 : 0;
            const gced = settings.isEnabled('gced') ? 1 : 0;

            // Lifespan 0 is alive, every other lifespan was collected
            return Uint8Array.from(dict, (_, lifespan) => lifespan === 0 ? alive : gced);
        }
    };
}
