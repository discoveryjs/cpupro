import type { DictDimension, TreeDimension } from '../computations/metrics.js';
import type { SampledCallTree } from '../preprocessing/samples.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProPackage } from '../types.js';
import type { LineTreeDimension, ProfileLineTree } from './types.js';

type LineTreeInput<T extends CpuProNode> = SampledCallTree<T> | null;

export function createLineTreeDimension<T extends CpuProNode>(
    sampledTree: LineTreeInput<T>,
    dict: DictDimension<T> | null,
    tree: TreeDimension<T> | null
): LineTreeDimension<T> | null {
    if (sampledTree === null || dict === null || tree === null) {
        return null;
    }

    return {
        tree: sampledTree.tree,
        sampleToNode: sampledTree.sampleToNode,
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
    sampledTrees: {
        locations: LineTreeInput<CpuProLocation>;
        callFrames: LineTreeInput<CpuProCallFrame>;
        modules: LineTreeInput<CpuProModule>;
        packages: LineTreeInput<CpuProPackage>;
        categories: LineTreeInput<CpuProCategory>;
    },
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
    }
): ProfileLineTree {
    return {
        kind,
        locations: createLineTreeDimension(sampledTrees.locations, dimensions.dict.locations, dimensions.tree.locations),
        callFrames: createLineTreeDimension(sampledTrees.callFrames, dimensions.dict.callFrames, dimensions.tree.callFrames),
        modules: createLineTreeDimension(sampledTrees.modules, dimensions.dict.modules, dimensions.tree.modules),
        packages: createLineTreeDimension(sampledTrees.packages, dimensions.dict.packages, dimensions.tree.packages),
        categories: createLineTreeDimension(sampledTrees.categories, dimensions.dict.categories, dimensions.tree.categories)
    };
}
