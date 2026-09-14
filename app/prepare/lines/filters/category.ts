import { SetAttributeFilter } from '../../computations/attribute-filter.js';
import type { ProfileLineBreakdown } from '../types.js';
import type { FilterComputation } from './types.js';
import { typeColor } from '../../const.js';

export function createCategoryFilter(breakdowns: ProfileLineBreakdown[]): FilterComputation {
    const { population } = breakdowns[0];
    const sources = [...new Set(breakdowns.map(breakdown => breakdown.source))];
    const names = new Set<string>();

    for (const source of sources) {
        for (const node of source.nodes) {
            const entry = source.dictionary[node];
            names.add(('callFrame' in entry ? entry.callFrame : entry).category.name);
        }
    }

    const options = [...names].map(name => ({
        key: name,
        label: name,
        color: typeColor[name]
    }));

    return {
        settings: new SetAttributeFilter('category', 'Categories', options),
        domain: 'sample',
        size: population.samplesCount.length,
        compile: settings => compileCategoryFilter(settings, sources)
    };
}

function compileCategoryFilter(settings: SetAttributeFilter, sources: ProfileLineBreakdown['source'][]) {
    const selected = new Set(settings.selectedKeys);
    const include = settings.mode === 'include';

    return (sampleId: number) => sources.some(({ dictionary, nodes, sourceIdToNode }) => {
        const entry = dictionary[nodes[sourceIdToNode[sampleId]]];
        const callFrame = 'callFrame' in entry ? entry.callFrame : entry;

        return selected.has(callFrame.category.name);
    }) === include;
}
