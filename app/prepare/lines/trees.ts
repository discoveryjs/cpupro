import type { DictDimension, SampledTree, TreeDimension } from '../computations/metrics.js';
import type { WorkHandler } from '../misc/work.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLine, ProfileLineBreakdown } from './types.js';
import { computeTreeMetrics, SampledCpuProCallTree } from '../preprocessing/samples.js';
import { PopulationFiltered, Population } from '../computations/population.js';

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

    // build samples lists & trees
    const {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dict,
        tree
    } = await work('process samples', () =>
        computeTreeMetrics(
            samples,
            values,
            sampledCallFramesTree,
            sampledModulesTree,
            sampledPackagesTree,
            sampledCategoriesTree,
            sampledOwnersTree,
            sampledLocationsTree
        )
    );

    return createLineTree(
        kind,
        line,
        { dict, tree },
        { samplesMetrics, samplesMetricsFiltered, recomputeMetrics }
    );
}

export function createBreakdownDimension<T extends CpuProNode>(
    dict: DictDimension<T> | null,
    tree: TreeDimension<T> | null
): LineTreeDimension<T> | null {
    if (dict === null || tree === null) {
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
        bounds: tree.bounds
    };
}

function createLineTree(
    kind: string,
    line: ProfileLine,
    dimensions: {
        dict: {
            locations: DictDimension<CpuProLocation> | null;
            callFrames: DictDimension<CpuProCallFrame> | null;
            modules: DictDimension<CpuProModule> | null;
            packages: DictDimension<CpuProPackage> | null;
            categories: DictDimension<CpuProCategory> | null;
            owners: DictDimension<CpuProOwner> | null;
        };
        tree: {
            locations: TreeDimension<CpuProLocation> | null;
            callFrames: TreeDimension<CpuProCallFrame> | null;
            modules: TreeDimension<CpuProModule> | null;
            packages: TreeDimension<CpuProPackage> | null;
            categories: TreeDimension<CpuProCategory> | null;
            owners: TreeDimension<CpuProOwner> | null;
        };
    },
    metrics: {
        samplesMetrics: Population;
        samplesMetricsFiltered: PopulationFiltered;
        recomputeMetrics: () => void;
    }
): ProfileLineBreakdown {
    return {
        kind,
        line,
        samplesMetrics: metrics.samplesMetrics,
        samplesMetricsFiltered: metrics.samplesMetricsFiltered,
        recomputeMetrics: metrics.recomputeMetrics,
        locations: createBreakdownDimension(dimensions.dict.locations, dimensions.tree.locations),
        callFrames: createBreakdownDimension(dimensions.dict.callFrames, dimensions.tree.callFrames),
        modules: createBreakdownDimension(dimensions.dict.modules, dimensions.tree.modules),
        packages: createBreakdownDimension(dimensions.dict.packages, dimensions.tree.packages),
        categories: createBreakdownDimension(dimensions.dict.categories, dimensions.tree.categories),
        owners: createBreakdownDimension(dimensions.dict.owners, dimensions.tree.owners)
    };
}
