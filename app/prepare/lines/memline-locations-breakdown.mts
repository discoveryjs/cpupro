import type { Dictionary } from '../dictionary.js';
import type { WorkHandler } from '../misc/work.js';
import type { GeneratedNodes } from '../preprocessing/nodes.js';
import type { TreeSource } from '../computations/build-trees.js';
import type { CpuProLocation } from '../types.js';
import type { ProfileLine, ProfileLineBreakdown } from './types.js';
import { createSampledTreeSet } from '../profile.mjs';
import { createLineBreakdown } from './trees.js';
import { Population, PopulationFiltered } from '../computations/population.js';
import { remapSamples } from '../preprocessing/samples.js';
import { convertToUint32Array, createInt32Progression } from '../misc/utils.js';

export async function createMemlineLocationsBreakdown(
    kind: string,
    line: ProfileLine,
    dictionary: Dictionary,
    allocationSizes: Uint32Array,
    vectorLocations: {
        generatedNodes: GeneratedNodes;
        samples: Uint32Array;
    },
    work: WorkHandler
): Promise<ProfileLineBreakdown> {
    const allocationLocationBreakdownBasis: TreeSource<CpuProLocation> =
        await work('compute location breakdown basis', () =>
            createAllocationLocationBreakdownBasis(
                dictionary,
                vectorLocations.generatedNodes
            )
        );
    const { samples, sampleToNode } = await work('normalize allocation locations', () =>
        remapSamples(vectorLocations.samples, allocationLocationBreakdownBasis.sourceIdToNode)
    );
    const locationSource = {
        ...allocationLocationBreakdownBasis,
        sourceIdToNode: sampleToNode
    };
    const population = await work('create allocation location population', () =>
        new PopulationFiltered(new Population(samples, allocationSizes))
    );
    const locationTreeSamples = await createSampledTreeSet(
        dictionary,
        locationSource,
        work
    );

    return createLineBreakdown(
        kind,
        line,
        population,
        locationTreeSamples,
        work
    );

}

function createAllocationLocationBreakdownBasis(
    dictionary: Dictionary,
    generatedNodes: GeneratedNodes
): TreeSource<CpuProLocation> {
    const nodeIndexById = createInt32Progression(generatedNodes.count);
    const nodeParent = convertToUint32Array(generatedNodes.nodeParentId);
    const locationNodes = convertToUint32Array(generatedNodes.parentScriptOffsets); // parentScriptOffsets used to store location indices

    return {
        parent: nodeParent,
        sourceIdToNode: nodeIndexById,
        nodes: locationNodes,
        dictionary: dictionary.locations
    };

    // call frames
    // const callFrameByNodeIndex = Uint32Array.from(generatedNodes.callFrames);
    // {
    //     nodeParent,
    //     nodeIndexById,
    //     callFrameByNodeIndex,
    //     dictionary: dictionary.callFrames
    // }
}
