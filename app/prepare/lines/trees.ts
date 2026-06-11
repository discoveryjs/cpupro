import type { DictDimension, SamplesMetrics, SamplesMetricsFiltered, TreeDimension } from '../computations/metrics.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLine, ProfileLineTree } from './types.js';

export function createLineTreeDimension<T extends CpuProNode>(
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

export function createLineTree(
    kind: string,
    line: ProfileLine,
    dimensions: {
        dict: {
            locations: DictDimension<CpuProLocation> | null;
            callFrames: DictDimension<CpuProCallFrame> | null;
            modules: DictDimension<CpuProModule> | null;
            packages: DictDimension<CpuProPackage> | null;
            categories: DictDimension<CpuProCategory> | null;
        };
        tree: {
            locations: TreeDimension<CpuProLocation> | null;
            callFrames: TreeDimension<CpuProCallFrame> | null;
            modules: TreeDimension<CpuProModule> | null;
            packages: TreeDimension<CpuProPackage> | null;
            categories: TreeDimension<CpuProCategory> | null;
        };
    },
    metrics: {
        samplesMetrics: SamplesMetrics;
        samplesMetricsFiltered: SamplesMetricsFiltered;
        recomputeMetrics: () => void;
    }
): ProfileLineTree {
    return {
        kind,
        line,
        samplesMetrics: metrics.samplesMetrics,
        samplesMetricsFiltered: metrics.samplesMetricsFiltered,
        recomputeMetrics: metrics.recomputeMetrics,
        locations: createLineTreeDimension(dimensions.dict.locations, dimensions.tree.locations),
        callFrames: createLineTreeDimension(dimensions.dict.callFrames, dimensions.tree.callFrames),
        modules: createLineTreeDimension(dimensions.dict.modules, dimensions.tree.modules),
        packages: createLineTreeDimension(dimensions.dict.packages, dimensions.tree.packages),
        categories: createLineTreeDimension(dimensions.dict.categories, dimensions.tree.categories)
    };
}
