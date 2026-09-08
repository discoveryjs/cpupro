import { TIMINGS } from '../const.js';
import { CallTree } from '../computations/call-tree.js';
import { createSampleBreakdown, DictDimension, SampledTree, TreeDimension } from '../computations/metrics.js';
import { convertToInt32Array } from '../misc/utils.js';
import {
    CpuProModule,
    CpuProCategory,
    CpuProPackage,
    CpuProNode,
    CpuProCallFrame,
    CpuProOwner,
    CpuProLocation
} from '../types.js';
import { PopulationFiltered } from '../computations/population.js';
import { TreeValueBounds } from '../computations/tree-node-bounds.js';

export type CpuProCallTree =
    | CallTree<CpuProLocation>
    | CallTree<CpuProCallFrame>
    | CallTree<CpuProModule>
    | CallTree<CpuProPackage>
    | CallTree<CpuProCategory>
    | CallTree<CpuProOwner>;

export type SampledCpuProCallTree =
    | SampledTree<CpuProLocation>
    | SampledTree<CpuProCallFrame>
    | SampledTree<CpuProModule>
    | SampledTree<CpuProPackage>
    | SampledTree<CpuProCategory>
    | SampledTree<CpuProOwner>;

export function createSampledCallTree<T extends CpuProNode>(
    tree: CallTree<T>,
    sampleToNode: Uint32Array
): SampledTree<T> {
    return {
        tree,
        sampleToNode
    };
}

// FIXME: sampleIdMap can contain -1 for missed IDs; normally, this shouldn't happen,
// but it is possible with corrupted or incomplete input data, so it probably makes sense to handle such cases
export function remapSamples(samples: Uint32Array, sampleIdMap: Int32Array) {
    const tmpMap = new Uint32Array(sampleIdMap.length);
    const remappedSamples: Uint32Array = new Uint32Array(samples.length);
    const samplesMap: number[] = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];
        const newSample = tmpMap[id];

        if (newSample === 0) {
            samplesMap.push(sampleIdMap[id]);
            tmpMap[id] = ++sampledNodesCount;
            remappedSamples[i] = sampledNodesCount - 1;
        } else {
            remappedSamples[i] = newSample - 1;
        }
    }

    // convert to typed array for faster processing
    return {
        samples: remappedSamples,
        sampleToNode: convertToInt32Array(samplesMap)
    };
}

export function remapTreeSamples(
    sampleIdToEntryTreeNode: Int32Array,
    trees: CpuProCallTree[]
) {
    const sampledTrees: SampledCpuProCallTree[] = [];
    const sampleToNodeBySourceTree = new Map<CpuProCallTree | null, Uint32Array>(
        [[null, new Uint32Array(sampleIdToEntryTreeNode)]]
    );

    while (sampledTrees.length < trees.length) {
        let foundNewTree = false;

        for (const tree of trees) {
            if (sampleToNodeBySourceTree.has(tree)) {
                continue;
            }

            const sourceTreeSampleToNode = sampleToNodeBySourceTree.get(tree.sourceTree as CpuProCallTree | null);

            if (sourceTreeSampleToNode !== undefined) {
                const treeSampleToNode = tree.sourceIdToNode;
                const sampleToNode = sourceTreeSampleToNode.map(id => treeSampleToNode[id]);

                foundNewTree = true;
                sampleToNodeBySourceTree.set(tree, sampleToNode);
                sampledTrees.push({
                    tree,
                    sampleToNode
                } as SampledCpuProCallTree);
            }
        }

        if (!foundNewTree) {
            throw new Error('Failed to remap samples for all trees');
        }
    }

    return sampledTrees;
}

function createTreeNodeBounds<T extends CpuProNode>(sampledTree: SampledTree<T>, population: PopulationFiltered) {
    const treeBounds = new TreeValueBounds<T>(
        sampledTree.tree,
        sampledTree.sampleToNode,
        population.cumulative,
        population.samples
    );

    return treeBounds;
}

export function computeTreeMetrics(
    population: PopulationFiltered,
    callFramesTree: SampledTree<CpuProCallFrame>,
    modulesTree: SampledTree<CpuProModule>,
    packagesTree: SampledTree<CpuProPackage>,
    categoriesTree: SampledTree<CpuProCategory>,
    ownersTree: SampledTree<CpuProOwner>,
    locationsTree: SampledTree<CpuProLocation> | null
) {
    // create metrics
    const computeStart = Date.now();
    const sampledTrees = [
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        ownersTree,
        ...locationsTree ? [locationsTree] : []
    ] as unknown as SampledTree<CpuProNode>[];
    const {
        recomputeMetrics,
        dimensions: [
            callFrameDimension,
            moduleDimension,
            packageDimension,
            categoryDimension,
            ownerDimension,
            locationDimension = null
        ]
    } = createSampleBreakdown(population, sampledTrees);

    // Reorganize dimensions into dict/tree structure
    const dict = {
        callFrames: callFrameDimension.dict as DictDimension<CpuProCallFrame>,
        modules: moduleDimension.dict as DictDimension<CpuProModule>,
        packages: packageDimension.dict as DictDimension<CpuProPackage>,
        categories: categoryDimension.dict as DictDimension<CpuProCategory>,
        owners: ownerDimension.dict as DictDimension<CpuProOwner>,
        locations: locationDimension?.dict as DictDimension<CpuProLocation> || null
    };

    const tree = {
        callFrames: callFrameDimension.tree as TreeDimension<CpuProCallFrame>,
        modules: moduleDimension.tree as TreeDimension<CpuProModule>,
        packages: packageDimension.tree as TreeDimension<CpuProPackage>,
        categories: categoryDimension.tree as TreeDimension<CpuProCategory>,
        owners: ownerDimension.tree as TreeDimension<CpuProOwner>,
        locations: locationDimension?.tree as TreeDimension<CpuProLocation> || null
    };

    const bounds = {
        callFrames: createTreeNodeBounds(callFramesTree, population),
        modules: createTreeNodeBounds(modulesTree, population),
        packages: createTreeNodeBounds(packagesTree, population),
        categories: createTreeNodeBounds(categoriesTree, population),
        owners: createTreeNodeBounds(ownersTree, population),
        locations: locationsTree ? createTreeNodeBounds(locationsTree, population) : null
    };

    TIMINGS && console.log('Compute timings:', Date.now() - computeStart);

    return {
        recomputeMetrics,
        dict,
        tree,
        bounds
    };
}
