import { TIMINGS } from '../const.js';
import { CallTree } from '../computations/call-tree.js';
import { computeMetrics, DictDimension, TreeDimension } from '../computations/metrics.js';
import { convertToUint32Array } from '../misc/utils.js';
import {
    CpuProModule,
    CpuProCategory,
    CpuProPackage,
    CpuProNode,
    CpuProCallFrame,
    CpuProLocation
} from '../types.js';

// Merging sequentially identical samples and coresponsing timeDeltas.
// Usually it allows to reduce number of samples for further processing at least by x2
export function mergeSamples(samples: Uint32Array, timeDeltas: Uint32Array, sampleLocations: Int32Array | null) {
    const sampleCounts = new Uint32Array(samples.length).fill(1);
    let k = 1;

    if (sampleLocations !== null) {
        for (let i = 1; i < samples.length; i++) {
            if (samples[i] !== samples[i - 1] || sampleLocations[i] !== sampleLocations[i - 1]) {
                timeDeltas[k] = timeDeltas[i];
                samples[k] = samples[i];
                sampleLocations[k] = sampleLocations[i];
                k++;
            } else {
                timeDeltas[k - 1] += timeDeltas[i];
                sampleCounts[k - 1]++;
            }
        }
    } else {
        for (let i = 1; i < samples.length; i++) {
            if (samples[i] !== samples[i - 1]) {
                timeDeltas[k] = timeDeltas[i];
                samples[k] = samples[i];
                k++;
            } else {
                timeDeltas[k - 1] += timeDeltas[i];
                sampleCounts[k - 1]++;
            }
        }
    }

    return k !== samples.length
        ? {
            samples: samples.slice(0, k),
            sampleCounts: sampleCounts.slice(0, k),
            sampleLocations: sampleLocations !== null ? sampleLocations.slice(0, k) : sampleLocations,
            timeDeltas: timeDeltas.slice(0, k)
        }
        : {
            samples,
            sampleCounts,
            sampleLocations,
            timeDeltas
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
    trees: CallTree<CpuProNode>[]
) {
    let sampleIdToNode = remapSamples(samples, sampleIdToEntryTreeNode);

    for (const tree of trees) {
        sampleIdToNode = sampleIdToNode.map(id => tree.sourceIdToNode[id]);
        tree.sampleIdToNode = sampleIdToNode;
    }
}

export function computeTimings(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    callFramesTree: CallTree<CpuProCallFrame>,
    modulesTree: CallTree<CpuProModule>,
    packagesTree: CallTree<CpuProPackage>,
    categoriesTree: CallTree<CpuProCategory>,
    locationsTree: CallTree<CpuProLocation> | null
) {
    // create metrics
    const computeTimingsStart = Date.now();
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
    } = computeMetrics(samples, timeDeltas, [
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        ...locationsTree ? [locationsTree] : []
    ]);

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

    TIMINGS && console.log('Compute timings:', Date.now() - computeTimingsStart);

    return {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dict,
        tree
    };
}
