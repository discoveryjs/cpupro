import type { WorkHandler } from '../misc/work.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
import { createLineBreakdown } from './breakdown.js';
import { Population, PopulationFiltered } from '../computations/population.js';
import { ProfileLine } from './types.js';

export async function createMemlineCpuSamplesBreakdown(
    kind: string,
    line: ProfileLine,
    _cpuproAllocationMapping: Uint32Array | number[],
    _cpuproAllocationIds: Uint32Array | number[],
    _cpuproAllocationSizes: Uint32Array | number[],
    cpuPopulation: Population,
    cpuSampledTreeSet: SampledTreeSet,
    work: WorkHandler
) {
    // Build allocation sample vector: map each allocation to its CPU sample node
    // _cpuproAllocationMapping[cpuSampleIdx] = last allocation ID when CPU sample taken
    // We need reverse: for each allocation, which CPU sample was it captured in?
    const allocationCount = _cpuproAllocationIds.length;
    const allocationCpuSamples = new Uint32Array(allocationCount);
    const allocationSizes = _cpuproAllocationSizes instanceof Uint32Array
        ? _cpuproAllocationSizes
        : new Uint32Array(_cpuproAllocationSizes);
    const cpuSamples = cpuPopulation.samples;

    await work('map allocations to CPU samples', () => {
        const cpuSampleCount = Math.min(_cpuproAllocationMapping.length, cpuSamples.length);
        let allocIdx = 0;

        for (let cpuIdx = 0; cpuIdx < cpuSampleCount; cpuIdx++) {
            const targetAllocId = _cpuproAllocationMapping[cpuIdx];

            if (targetAllocId === undefined) {
                continue;
            }

            const cpuSample = cpuSamples[cpuIdx];

            // All allocations up to targetAllocId belong to this CPU sample
            while (allocIdx < allocationCount && _cpuproAllocationIds[allocIdx] <= targetAllocId) {
                allocationCpuSamples[allocIdx] = cpuSample;
                allocIdx++;
            }
        }

        allocationCpuSamples.fill(cpuSamples[cpuSamples.length - 1], allocIdx);
    });

    return createLineBreakdown(
        kind,
        line,
        new PopulationFiltered(new Population(allocationCpuSamples, allocationSizes)),
        cpuSampledTreeSet,
        work
    );
}
