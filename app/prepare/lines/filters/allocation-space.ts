import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import type { ProfileLineAttribute } from '../types.js';
import type { FilterComputation } from './types.js';

export function createAllocationSpaceFilter(attribute: ProfileLineAttribute, eventCount: number): FilterComputation | null {
    if (attribute.name !== 'allocationSpace' || attribute.values.length !== eventCount || !attribute.dict.length) {
        return null;
    }

    const { values, dict } = attribute;
    const options = dict.map(entry => ({
        key: entry.code,
        label: entry.name,
        color: entry.color
    }));

    return {
        settings: new SetAttributeFilter('allocationSpace', 'Space', options),
        domain: 'event',
        size: eventCount,
        compile(settings) {
            const allowed = Uint8Array.from(dict, entry => settings.isEnabled(entry.code) ? 1 : 0);

            return index => allowed[values[index]] === 1;
        }
    };
}
