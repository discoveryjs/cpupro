import { TIMINGS } from '../const.js';
import { createSampleBreakdown, type DictDimension, type SampledTree, type TreeDimension } from '../computations/metrics.js';
import type { WorkHandler } from '../misc/work.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLine, ProfileLineBreakdown } from './types.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
import type { PopulationFiltered } from '../computations/population.js';
import { TreeValueBounds } from '../computations/tree-node-bounds.js';

export async function createLineBreakdown(
    kind: string,
    line: ProfileLine,
    populationFiltered: PopulationFiltered,
    { source, sampledTrees }: SampledTreeSet,
    work: WorkHandler
): Promise<ProfileLineBreakdown> {
    const { recomputeMetrics, dimensions } = await work('compute breakdown metrics', () => {
        const computeStart = Date.now();
        const { recomputeMetrics, dimensions } = createSampleBreakdown(populationFiltered, sampledTrees);
        const lineDimensions = dimensions.map((dimension, index) =>
            createBreakdownDimension(dimension, sampledTrees[index], populationFiltered)
        );

        TIMINGS && console.log('Compute timings:', Date.now() - computeStart);

        return { recomputeMetrics, dimensions: lineDimensions };
    });
    const offset = sampledTrees.length > 5 ? 1 : 0;

    return {
        kind,
        line,
        source,
        samplesMetrics: populationFiltered.population,
        samplesMetricsFiltered: populationFiltered,
        recomputeMetrics,
        locations: offset ? dimensions[0] as LineTreeDimension<CpuProLocation> : null,
        callFrames: dimensions[offset] as LineTreeDimension<CpuProCallFrame>,
        modules: dimensions[offset + 1] as LineTreeDimension<CpuProModule>,
        packages: dimensions[offset + 2] as LineTreeDimension<CpuProPackage>,
        categories: dimensions[offset + 3] as LineTreeDimension<CpuProCategory>,
        owners: dimensions[offset + 4] as LineTreeDimension<CpuProOwner>
    };
}

function createBreakdownDimension<T extends CpuProNode>(
    { dict, tree }: { dict: DictDimension<T>; tree: TreeDimension<T> },
    sampledTree: SampledTree<T>,
    population: PopulationFiltered
): LineTreeDimension<T> {
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
        bounds: new TreeValueBounds(
            sampledTree.tree,
            sampledTree.sampleToNode,
            population.cumulative,
            population.samples
        )
    };
}
