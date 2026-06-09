import { TIMINGS } from '../const.js';
import { CallTree } from '../computations/call-tree.js';
import { computeMetrics, DictDimension, SampledTree, TreeDimension } from '../computations/metrics.js';
import { convertToUint32Array } from '../misc/utils.js';
import {
    CpuProModule,
    CpuProCategory,
    CpuProPackage,
    CpuProNode,
    CpuProCallFrame,
    CpuProLocation
} from '../types.js';

export type CpuProCallTree =
    | CallTree<CpuProLocation>
    | CallTree<CpuProCallFrame>
    | CallTree<CpuProModule>
    | CallTree<CpuProPackage>
    | CallTree<CpuProCategory>;

export type SampledCpuProCallTree =
    | SampledTree<CpuProLocation>
    | SampledTree<CpuProCallFrame>
    | SampledTree<CpuProModule>
    | SampledTree<CpuProPackage>
    | SampledTree<CpuProCategory>;

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
    const samplesMap: number[] = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];
        const newSampleId = tmpMap[id];

        if (newSampleId === 0) {
            samplesMap.push(sampleIdMap[id]);
            tmpMap[id] = ++sampledNodesCount;
            samples[i] = sampledNodesCount - 1;
        } else {
            samples[i] = newSampleId - 1;
        }
    }

    // convert to typed array for faster processing
    return convertToUint32Array(samplesMap);
}

export function remapTreeSamples(
    samples: Uint32Array,
    sampleIdToEntryTreeNode: Int32Array,
    trees: CpuProCallTree[]
) {
    let sampleToNode = remapSamples(samples, sampleIdToEntryTreeNode);
    const sampledTrees: SampledCpuProCallTree[] = [];

    for (const tree of trees) {
        sampleToNode = sampleToNode.map(id => tree.sourceIdToNode[id]);
        sampledTrees.push(createSampledCallTree(
            tree as CallTree<CpuProNode>,
            sampleToNode
        ) as SampledCpuProCallTree);
    }

    return sampledTrees;
}

export function computeTreeMetrics(
    samples: Uint32Array,
    values: Uint32Array,
    callFramesTree: SampledTree<CpuProCallFrame>,
    modulesTree: SampledTree<CpuProModule>,
    packagesTree: SampledTree<CpuProPackage>,
    categoriesTree: SampledTree<CpuProCategory>,
    locationsTree: SampledTree<CpuProLocation> | null
) {
    // create metrics
    const computeStart = Date.now();
    const metricTrees = [
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        ...locationsTree ? [locationsTree] : []
    ] as unknown as SampledTree<CpuProNode>[];
    const {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dimensions: [
            callFrameDimension,
            moduleDimension,
            packageDimension,
            categoryDimension,
            locationDimension = null
        ]
    } = computeMetrics(samples, values, metricTrees);

    // Reorganize dimensions into dict/tree structure
    const dict = {
        callFrames: callFrameDimension.dict as DictDimension<CpuProCallFrame>,
        modules: moduleDimension.dict as DictDimension<CpuProModule>,
        packages: packageDimension.dict as DictDimension<CpuProPackage>,
        categories: categoryDimension.dict as DictDimension<CpuProCategory>,
        locations: locationDimension?.dict as DictDimension<CpuProLocation> || null
    };

    const tree = {
        callFrames: callFrameDimension.tree as TreeDimension<CpuProCallFrame>,
        modules: moduleDimension.tree as TreeDimension<CpuProModule>,
        packages: packageDimension.tree as TreeDimension<CpuProPackage>,
        categories: categoryDimension.tree as TreeDimension<CpuProCategory>,
        locations: locationDimension?.tree as TreeDimension<CpuProLocation> || null
    };

    TIMINGS && console.log('Compute timings:', Date.now() - computeStart);

    return {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dict,
        tree
    };
}
