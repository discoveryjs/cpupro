import { SetAttributeFilter } from '../computations/population-filter.js';
import type { ProfileLineBreakdown } from './types.js';
import { typeColor } from '../const.js';

export function registerPopulationFilters(breakdown: ProfileLineBreakdown) {
    const population = breakdown.populationFiltered;
    const attributes = breakdown.line.attributes;
    const categories = breakdown.categories;

    population.filter.batch(() => {
        if (categories) {
            const categoryTree = categories.tree;
            const options = categoryTree.dictionary.map(entry => ({
                key: entry.name,
                label: entry.name,
                color: typeColor[entry.name]
            }));
            population.filter.add(new SetAttributeFilter(
                'category', 'Categories', 'sample', population.samplesMask.length, options,
                sampleId => categoryTree.nodes[categories.sampleToNode[sampleId]]
            ));
        }

        const lifespan = attributes.find(attribute => attribute.name === 'allocationLifespan');
        if (lifespan && lifespan.values.length === population.population.samples.length) {
            population.filter.add(new SetAttributeFilter(
                'allocationLiveness', 'Allocations', 'event', lifespan.values.length,
                [{ key: 'alive', label: 'Alive' }, { key: 'gced', label: 'GCed' }],
                index => lifespan.values[index] === 0 ? 0 : 1
            ));
        }

        const space = attributes.find(attribute => attribute.name === 'allocationSpace');
        if (space && space.values.length === population.population.samples.length && space.dict.length) {
            population.filter.add(new SetAttributeFilter(
                'allocationSpace', 'Space', 'event', space.values.length,
                space.dict.map(entry => ({ key: String(entry.code), label: entry.name, color: entry.color })),
                index => space.values[index]
            ));
        }
    });
}
