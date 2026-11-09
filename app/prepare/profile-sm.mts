import type { Dictionary } from './dictionary.js';
import type { ProfileLine, ProfileLineBreakdown } from './lines/types.js';
import type { WorkHandler } from './misc/work.js';
import { createSampledTreeSet } from './computations/sampled-tree-set.js';
import { createLineBreakdown } from './lines/breakdown.js';

// Creates a breakdown of the same populations as the given breakdown, with locations of its tree
// replaced by original locations (see SourceMapping#mapLocations()). Only location trees are mapped.
export async function createSourceMappedBreakdown(
    kind: string,
    line: ProfileLine,
    breakdown: ProfileLineBreakdown,
    dictionary: Dictionary,
    originalLocations: Int32Array,
    work: WorkHandler
) {
    const { source } = breakdown;

    if (source.dictionary !== dictionary.locations) {
        return null;
    }

    const sampledTreeSet = await createSampledTreeSet(
        dictionary,
        {
            ...source,
            nodes: source.nodes.map(location => originalLocations[location])
        },
        work
    );

    return createLineBreakdown(
        kind,
        line,
        breakdown.populationFiltered,
        breakdown.populationViewport,
        breakdown.populationWindow,
        sampledTreeSet,
        work
    );
}
