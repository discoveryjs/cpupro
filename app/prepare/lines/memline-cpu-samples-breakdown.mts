import type { WorkHandler } from '../misc/work.js';
import { sampledTreeSetOfSourceIds, type SampledTreeSet } from '../computations/sampled-tree-set.js';
import { createLineBreakdown } from './breakdown.js';
import { Population, PopulationFiltered } from '../computations/population.js';
import { ProfileLine } from './types.js';

export async function createMemlineCpuSamplesBreakdown(
    kind: string,
    line: ProfileLine,
    allocationSamples: Uint32Array, // per allocation: the index of its CPU sample
    allocationSizes: Uint32Array,
    cumulative: Float64Array, // prefix sums of allocation sizes, shared by the populations of the memline
    cpuPopulation: Population,
    cpuSampledTreeSet: SampledTreeSet,
    work: WorkHandler
) {
    // An allocation is attributed to the call stack of its CPU sample: allocations are samples of the CPU samples,
    // whose source ids give the tree set of the CPU population a source of CPU samples
    // PERF: The CPU samples of allocations are the mapping of the memline to the timeline, so the population takes them
    // rather than a vector of the nodes of allocations, a pass over the allocations
    const treeSet = sampledTreeSetOfSourceIds(cpuSampledTreeSet, cpuPopulation.samples);
    const population = new Population(
        allocationSamples,
        allocationSizes,
        cpuPopulation.samples.length,
        cumulative,
        line.eventClasses
    );
    const populationViewport = new PopulationFiltered(population);
    const populationFiltered = new PopulationFiltered(populationViewport);
    const populationWindow = new PopulationFiltered(population);

    return createLineBreakdown(
        kind,
        line,
        populationFiltered,
        populationViewport,
        populationWindow,
        treeSet,
        work
    );
}
