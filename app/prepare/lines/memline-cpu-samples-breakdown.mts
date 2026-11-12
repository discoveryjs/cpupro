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
    cpuPopulation: Population,
    cpuSampledTreeSet: SampledTreeSet,
    work: WorkHandler
) {
    // An allocation is attributed to the call stack of its CPU sample
    const allocationCpuSamples = new Uint32Array(allocationSamples.length);
    const cpuSamples = cpuPopulation.samples;

    for (let i = 0; i < allocationSamples.length; i++) {
        allocationCpuSamples[i] = cpuSamples[allocationSamples[i]];
    }

    const population = new Population(allocationCpuSamples, allocationSizes);
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
