import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import type { ProfileLineAttribute } from '../types.js';
import type { FilterComputation } from './types.js';

export function createAllocationLivenessFilter(attribute: ProfileLineAttribute, eventCount: number): FilterComputation | null {
    if (attribute.name !== 'allocationLifespan' || attribute.values.length !== eventCount) {
        return null;
    }

    const { values } = attribute;
    const options = [
        { key: 'alive', label: 'Alive' },
        { key: 'gced', label: 'GCed' }
    ];

    return {
        settings: new SetAttributeFilter('allocationLiveness', 'Allocations', options),
        domain: 'event',
        size: eventCount,
        compile(settings) {
            const alive = settings.isEnabled('alive');
            const gced = settings.isEnabled('gced');

            return index => values[index] === 0 ? alive : gced;
        }
    };
}
