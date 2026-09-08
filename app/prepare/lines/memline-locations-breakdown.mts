import type { Dictionary } from '../dictionary.js';
import type { WorkHandler } from '../misc/work.js';
import type { GeneratedNodes } from '../preprocessing/nodes.js';
import type { TreeSource } from '../computations/build-trees.js';
import type { CpuProLocation } from '../types.js';
import type { ProfileLine } from './types.js';
import { createSampledTreeSet } from '../profile.mjs';
import { createLineBreakdown } from './trees.js';
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
) {
    const allocationLocationBreakdownBasis: TreeSource<CpuProLocation> =
        await work('compute location breakdown basis', () =>
            createAllocationLocationBreakdownBasis(
                dictionary,
                vectorLocations.generatedNodes
            )
        );
    const locationTreeSamples = await createSampledTreeSet(
        dictionary,
        allocationLocationBreakdownBasis,
        vectorLocations.samples,
        work
    );

    const breakdown = createLineBreakdown(
        kind,
        line,
        allocationSizes,
        locationTreeSamples,
        work
    );

    // FIXME: temporary for a source-maps breakdown
    line.__allocationLocationBreakdownBasis = locationTreeSamples.source;

    return breakdown;
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
