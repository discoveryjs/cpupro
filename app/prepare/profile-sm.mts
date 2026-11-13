import type { Dictionary } from './dictionary.js';
import type { SourceMapping } from './preprocessing/source-mapping.js';
import type { ProfileLine, ProfileLineBreakdown } from './lines/types.js';
import type { WorkHandler } from './misc/work.js';
import { createSampledTreeSet, sampledTreeSetOfSourceIds, type SampledTreeSet } from './computations/sampled-tree-set.js';
import { createLineBreakdown } from './lines/breakdown.js';

// Creates a breakdown of the same populations as the given breakdown, with locations of its tree
// replaced by original locations (see SourceMapping#mapLocations()). Only location trees are mapped,
// and only when the session has source maps. Source mapped tree sets are kept by the source they map: a source
// of samples of another source is mapped with it, its tree set takes the other's through the source ids of its
// samples, and isn't mapped when the other isn't (no source maps, a source of call frames)
export async function createSourceMappedBreakdown(
    kind: string,
    line: ProfileLine,
    breakdown: ProfileLineBreakdown,
    dictionary: Dictionary,
    sourceMapping: SourceMapping,
    mappedTreeSets: Map<SampledTreeSet['source'], SampledTreeSet | null>, // null for a source that isn't mapped
    work: WorkHandler
) {
    const { source } = breakdown;
    const { origin } = source;
    let sampledTreeSet: SampledTreeSet | null = null;

    if (origin !== undefined) {
        const originTreeSet = mappedTreeSets.get(origin.source);

        // An origin unknown here is not mapped yet rather than not mapped: its breakdowns are mapped first
        if (originTreeSet === undefined) {
            throw new Error('A source of samples of another source is mapped before that source');
        }

        if (originTreeSet !== null) {
            sampledTreeSet = sampledTreeSetOfSourceIds(originTreeSet, origin.sourceIds);
        }
    } else {
        sampledTreeSet = await createMappedTreeSet(source, dictionary, sourceMapping, work);
    }

    mappedTreeSets.set(source, sampledTreeSet);

    if (sampledTreeSet === null) {
        return null;
    }

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

async function createMappedTreeSet(
    source: SampledTreeSet['source'],
    dictionary: Dictionary,
    sourceMapping: SourceMapping,
    work: WorkHandler
) {
    const originalLocations = await work('process source maps', () =>
        sourceMapping.mapLocations(source)
    );

    if (originalLocations === null || !sourceMapping.hasSourceMaps) {
        return null;
    }

    return createSampledTreeSet(
        dictionary,
        {
            ...source,
            nodes: source.nodes.map(location => originalLocations[location])
        },
        work
    );
}
