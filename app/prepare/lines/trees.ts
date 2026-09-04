import type { DictDimension, SampledTree, TreeDimension } from '../computations/metrics.js';
import type { WorkHandler } from '../misc/work.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLine } from './types.js';
import { computeTreeMetrics, SampledCpuProCallTree } from '../preprocessing/samples.js';
import { PopulationFiltered, Population } from '../computations/population.js';
import { TreeValueBounds } from '../computations/tree-node-bounds.js';

export async function createLineBreakdown(
    kind: string,
    line: ProfileLine,
    values: Uint32Array,
    { samples, sampledTrees }: {
        samples: Uint32Array<ArrayBufferLike>;
        sampledTrees: SampledCpuProCallTree[];
    },
    work: WorkHandler
) {
    let sampledTreeOffset = 0;
    const sampledLocationsTree = sampledTrees.length > 5
        ? sampledTrees[sampledTreeOffset++] as SampledTree<CpuProLocation>
        : null;
    const sampledCallFramesTree = sampledTrees[sampledTreeOffset++] as SampledTree<CpuProCallFrame>;
    const sampledModulesTree = sampledTrees[sampledTreeOffset++] as SampledTree<CpuProModule>;
    const sampledPackagesTree = sampledTrees[sampledTreeOffset++] as SampledTree<CpuProPackage>;
    const sampledCategoriesTree = sampledTrees[sampledTreeOffset++] as SampledTree<CpuProCategory>;
    const sampledOwnersTree = sampledTrees[sampledTreeOffset++] as SampledTree<CpuProOwner>;
    const population = new Population(samples, values);
    const populationFiltered = new PopulationFiltered(population);

    // build samples lists & trees
    const {
        recomputeMetrics,
        dict,
        tree,
        bounds
    } = await work('process samples', () =>
        computeTreeMetrics(
            populationFiltered,
            sampledCallFramesTree,
            sampledModulesTree,
            sampledPackagesTree,
            sampledCategoriesTree,
            sampledOwnersTree,
            sampledLocationsTree
        )
    );

    return {
        kind,
        line,
        samplesMetrics: population,
        samplesMetricsFiltered: populationFiltered,
        recomputeMetrics,
        locations: createBreakdownDimension(dict.locations, tree.locations, bounds.locations),
        callFrames: createBreakdownDimension(dict.callFrames, tree.callFrames, bounds.callFrames),
        modules: createBreakdownDimension(dict.modules, tree.modules, bounds.modules),
        packages: createBreakdownDimension(dict.packages, tree.packages, bounds.packages),
        categories: createBreakdownDimension(dict.categories, tree.categories, bounds.categories),
        owners: createBreakdownDimension(dict.owners, tree.owners, bounds.owners)
    };
}

export function createBreakdownDimension<T extends CpuProNode>(
    dict: DictDimension<T> | null,
    tree: TreeDimension<T> | null,
    bounds: TreeValueBounds<T> | null
): LineTreeDimension<T> | null {
    if (dict === null || tree === null || bounds === null) {
        return null;
    }

    return {
        tree: tree.all.tree,
        sampleToNode: tree.all.sampleToNode,
        all: {
            nodes: tree.all,
            dict: dict.all
        },
        filtered: {
            nodes: tree.filtered,
            dict: dict.filtered
        },
        bounds
    };
}
