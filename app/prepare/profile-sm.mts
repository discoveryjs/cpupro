import type { Dictionary } from './dictionary.js';
import type { SourceMapping } from './preprocessing/source-mapping.js';
import type { ProfileLine, ProfileLineBreakdown } from './lines/types.js';
import type { WorkHandler } from './misc/work.js';
import { createSampledTreeSet } from './computations/sampled-tree-set.js';
import { createLineBreakdown } from './lines/breakdown.js';

// Creates a breakdown of the same populations as the given breakdown, with locations of its tree
// replaced by original locations (see SourceMapping#mapLocations()). Only location trees are mapped,
// and only when the session has source maps.
export async function createSourceMappedBreakdown(
    kind: string,
    line: ProfileLine,
    breakdown: ProfileLineBreakdown,
    dictionary: Dictionary,
    sourceMapping: SourceMapping,
    work: WorkHandler
) {
    const { source } = breakdown;
    const originalLocations = await work('process source maps', () =>
        sourceMapping.mapLocations(source)
    );

    if (originalLocations === null || !sourceMapping.hasSourceMaps) {
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
