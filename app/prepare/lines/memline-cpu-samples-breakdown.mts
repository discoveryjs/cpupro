import type { WorkHandler } from '../misc/work.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
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
    // An allocation is attributed to the call stack of its CPU sample: the node of the sample in the CPU population
    const allocationNodes = new Uint32Array(allocationSamples.length);
    const sampleNodes = cpuPopulation.samples;

    for (let i = 0; i < allocationSamples.length; i++) {
        allocationNodes[i] = sampleNodes[allocationSamples[i]];
    }

    // PERF: Nodes are indices of the CPU tree source, so their count needs no scan over the allocations
    const population = new Population(
        allocationNodes,
        allocationSizes,
        cpuSampledTreeSet.source.sourceIdToNode.length,
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
        cpuSampledTreeSet,
        work
    );
}
