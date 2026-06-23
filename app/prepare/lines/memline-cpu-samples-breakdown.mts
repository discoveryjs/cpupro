import type { WorkHandler } from '../misc/work.js';
import { SampledCpuProCallTree } from '../preprocessing/samples.js';
import { createLineBreakdown } from './trees.js';
import { ProfileLine } from './types.js';

export async function createMemlineCpuSamplesBreakdown(
    kind: string,
    line: ProfileLine,
    _cpuproAllocationMapping: Uint32Array | number[],
    _cpuproAllocationIds: Uint32Array | number[],
    _cpuproAllocationSizes: Uint32Array | number[],
    cpuSampledTreeSet: {
        samples: Uint32Array<ArrayBufferLike>;
        sampledTrees: SampledCpuProCallTree[];
    },
    work: WorkHandler
) {
    // Build allocation sample vector: map each allocation to its CPU sample node
    // _cpuproAllocationMapping[cpuSampleIdx] = last allocation ID when CPU sample taken
    // We need reverse: for each allocation, which CPU sample was it captured in?
    const allocationCount = _cpuproAllocationIds.length;
    const allocationCpuSamples = new Uint32Array(allocationCount);
    const allocationSizes = new Uint32Array(allocationCount);
    const {
        samples: cpuSamples,
        sampledTrees: cpuSampledTrees
    } = cpuSampledTreeSet;

    await work('map allocations to CPU samples', () => {
        let allocIdx = 0;

        for (let cpuIdx = 0; cpuIdx < _cpuproAllocationMapping.length; cpuIdx++) {
            const targetAllocId = _cpuproAllocationMapping[cpuIdx];

            if (targetAllocId === undefined) {
                continue;
            }

            const cpuSample = cpuSamples[cpuIdx];

            // All allocations up to targetAllocId belong to this CPU sample
            while (allocIdx < allocationCount && _cpuproAllocationIds[allocIdx] <= targetAllocId) {
                allocationCpuSamples[allocIdx] = cpuSample;
                allocationSizes[allocIdx] = _cpuproAllocationSizes[allocIdx] || 0;
                allocIdx++;
            }
        }
    });

    return createLineBreakdown(
        kind,
        line,
        allocationSizes,
        { samples: allocationCpuSamples, sampledTrees: cpuSampledTrees },
        work
    );
}
