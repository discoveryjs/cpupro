import { SetAttributeFilter, type FilterOption } from '../../computations/attribute-filter.js';
import type { ProfileLineAttribute } from '../types.js';
import type { FilterComputation } from './types.js';

type AttributeFilterOptions = {
    label: string;
    options: FilterOption[];
};

// A filter over the values of a line attribute: option `i` is the dictionary entry `i`, and the acceptance table
// is indexed by attribute values, a value taking the option of its entry
export function createAttributeFilter(attribute: ProfileLineAttribute, eventCount: number): FilterComputation | null {
    const filter = attributeFilterOptions(attribute);

    if (filter === null || attribute.keys.length !== eventCount || attribute.dict.length === 0) {
        return null;
    }

    const { options } = filter;

    return {
        settings: new SetAttributeFilter(attribute.name, filter.label, options),
        domain: 'event',
        size: eventCount,
        // A line keys the values of its attributes by signatures once it has them
        get values() {
            return attribute.keys;
        },
        compile(settings) {
            const enabled = options.map(option => settings.isEnabled(option.key) ? 1 : 0);
            const { entries } = attribute;
            const accepts = new Uint8Array(entries.length);

            for (let i = 0; i < entries.length; i++) {
                accepts[i] = enabled[entries[i]];
            }

            return accepts;
        }
    };
}

function attributeFilterOptions(attribute: ProfileLineAttribute): AttributeFilterOptions | null {
    switch (attribute.name) {
        case 'allocationType':
            return {
                label: 'Type',
                options: attribute.dict.map(name => ({
                    key: name,
                    label: name
                }))
            };

        case 'allocationSpace':
            return {
                label: 'Space',
                options: attribute.dict.map(entry => ({
                    key: entry.code,
                    label: entry.name,
                    color: entry.color
                }))
            };

        case 'allocationLifespan':
            return {
                label: 'Lifespan',
                options: attribute.dict.map(name => ({
                    key: name,
                    label: name
                }))
            };

        case 'allocationGcEpoch':
            return {
                label: 'GC',
                options: attribute.dict.map(entry => ({
                    key: `${entry.type}#${entry.epoch}`,
                    label: entry.type === 'none' ? 'survived' : `${entry.type} #${entry.epoch}`,
                    color: entry.color
                }))
            };

        case 'allocationCodeType':
            return {
                label: 'Code type',
                options: attribute.dict.map(name => ({
                    key: name,
                    label: name
                }))
            };

        case 'allocationCompilationStage':
            return {
                label: 'Compilation stage',
                options: attribute.dict.map(name => ({
                    key: name,
                    label: name
                }))
            };

        // Identity-like: an owner per compiled function, too many values to choose from
        case 'allocationOwner':
            return null;
    }
}
