import type { Dictionary } from '../dictionary.js';
import type { WorkHandler } from '../misc/work.js';
import type { VectorLocations } from '../preprocessing/locations.js';
import type { ProfileLine, ProfileLineBreakdown } from './types.js';
import { createSampledTreeSet } from '../computations/sampled-tree-set.js';
import { createLineBreakdown } from './breakdown.js';
import { Population, PopulationFiltered } from '../computations/population.js';

export async function createMemlineLocationsBreakdown(
    kind: string,
    line: ProfileLine,
    dictionary: Dictionary,
    allocationSizes: Uint32Array,
    cumulative: Float64Array, // prefix sums of allocation sizes, shared by the populations of the memline
    vectorLocations: VectorLocations,
    work: WorkHandler
): Promise<ProfileLineBreakdown> {
    const { samples, ...locationSource } = vectorLocations;
    const population = await work('create allocation location population', () => {
        // PERF: Samples are indices of sourceIdToNode, so their count needs no scan over the allocations
        const population = new Population(
            samples,
            allocationSizes,
            locationSource.sourceIdToNode.length,
            cumulative,
            line.eventClasses
        );
        const populationViewport = new PopulationFiltered(population);
        const populationFiltered = new PopulationFiltered(populationViewport);
        const populationWindow = new PopulationFiltered(population);

        return { populationViewport, populationFiltered, populationWindow };
    });
    const locationTreeSamples = await createSampledTreeSet(
        dictionary,
        locationSource,
        work
    );

    return createLineBreakdown(
        kind,
        line,
        population.populationFiltered,
        population.populationViewport,
        population.populationWindow,
        locationTreeSamples,
        work
    );
}
