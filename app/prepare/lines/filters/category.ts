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

    const { values, classes } = createCategoryClasses(sources, population.samplesCount.length);

    return {
        settings: new SetAttributeFilter('category', 'Categories', options),
        domain: 'sample',
        size: population.samplesCount.length,
        values,
        compile: settings => compileCategoryFilter(settings, classes)
    };
}

// Samples with the same category in every attribution are always accepted or rejected together,
// so acceptance is prepared per class of such samples rather than per sample
function createCategoryClasses(sources: ProfileLineBreakdown['source'][], sampleCount: number) {
    const classIds = new Map<string, number>();
    const classes: string[][] = [];
    const values = new Uint32Array(sampleCount);

    for (let sampleId = 0; sampleId < sampleCount; sampleId++) {
        const names = sources.map(({ dictionary, nodes, sourceIdToNode }) => {
            const entry = dictionary[nodes[sourceIdToNode[sampleId]]];

            return ('callFrame' in entry ? entry.callFrame : entry).category.name;
        });
        const key = names.join('\n');
        let classId = classIds.get(key);

        if (classId === undefined) {
            classId = classes.push(names) - 1;
            classIds.set(key, classId);
        }

        values[sampleId] = classId;
    }

    return { values, classes };
}

function compileCategoryFilter(settings: SetAttributeFilter, classes: string[][]) {
    const selected = new Set(settings.selectedKeys);
    const include = settings.mode === 'include';

    return Uint8Array.from(classes, names => names.some(name => selected.has(name)) === include ? 1 : 0);
}
