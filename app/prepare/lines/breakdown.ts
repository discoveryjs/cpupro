import { TIMINGS } from '../const.js';
import { createSampleBreakdown, type DictDimension, type TreeDimension } from '../computations/metrics.js';
import type { WorkHandler } from '../misc/work.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLine, ProfileLineBreakdown } from './types.js';
import type { SampledTreeDimension, SampledTreeSet } from '../computations/sampled-tree-set.js';
import type { Population, PopulationFiltered } from '../computations/population.js';
import { TreeValueBounds } from '../computations/tree-node-bounds.js';

export async function createLineBreakdown(
    kind: string,
    line: ProfileLine,
    populationFiltered: PopulationFiltered,
    populationViewport: PopulationFiltered,
    populationWindow: PopulationFiltered,
    { source, sampledTrees, dimensions: dimensionNames }: SampledTreeSet,
    work: WorkHandler
): Promise<ProfileLineBreakdown> {
    const population = populationFiltered.population;
    const { recomputeMetrics, dimensions } = await work('create breakdown dimensions', () => {
        const computeStart = Date.now();
        const { recomputeMetrics, dimensions } = createSampleBreakdown(populationFiltered, sampledTrees);
        const lineDimensions = dimensions.map(dimension =>
            createBreakdownDimension(dimension, population)
        );

        TIMINGS && console.log('Compute timings:', Date.now() - computeStart);

        return { recomputeMetrics, dimensions: lineDimensions };
    });
    const dimensionByName: Partial<Record<SampledTreeDimension, LineTreeDimension<CpuProNode>>> = {};

    for (let i = 0; i < dimensionNames.length; i++) {
        dimensionByName[dimensionNames[i]] = dimensions[i];
    }

    return {
        kind,
        line,
        source,
        population,
        populationViewport,
        populationWindow,
        populationFiltered,
        recomputeMetrics,
        locations: (dimensionByName.locations ?? null) as LineTreeDimension<CpuProLocation> | null,
        callFrames: dimensionByName.callFrames as LineTreeDimension<CpuProCallFrame>,
        modules: dimensionByName.modules as LineTreeDimension<CpuProModule>,
        packages: dimensionByName.packages as LineTreeDimension<CpuProPackage>,
        categories: dimensionByName.categories as LineTreeDimension<CpuProCategory>,
        owners: dimensionByName.owners as LineTreeDimension<CpuProOwner>
    };
}

function createBreakdownDimension<T extends CpuProNode>(
    { dict, tree }: { dict: DictDimension<T>; tree: TreeDimension<T> },
    population: Population
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
            tree.all.tree,
            tree.all.sampleToNode,
            population.cumulative,
            population.samples
        )
    };
}
