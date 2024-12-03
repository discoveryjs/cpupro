import { TIMINGS } from '../const.js';
import { CallTree } from '../computations/call-tree.js';
import {
    createTreeCompute,
    DictionaryTimings,
    SamplesTimings,
    SamplesTimingsFiltered,
    TreeTimestamps,
    TreeTimings
} from '../computations/timings.js';
import {
    CpuProModule,
    CpuProCategory,
    CpuProPackage,
    CpuProNode,
    CpuProCallFrame,
    CpuProCallFramePosition
} from '../types.js';
import { convertToUint32Array } from '../utils.js';

type SamplesResult = {
    recomputeTimings(): void;
    samplesTimings: SamplesTimings;
    samplesTimingsFiltered: SamplesTimingsFiltered;

    callFramePositionsTimings: DictionaryTimings<CpuProCallFramePosition> | null;
    callFramesTimings: DictionaryTimings<CpuProCallFrame>;
    modulesTimings: DictionaryTimings<CpuProModule>;
    packagesTimings: DictionaryTimings<CpuProPackage>;
    categoriesTimings: DictionaryTimings<CpuProCategory>;

    callFramePositionsTreeTimings: TreeTimings<CpuProCallFramePosition> | null;
    callFramesTreeTimings: TreeTimings<CpuProCallFrame>;
    modulesTreeTimings: TreeTimings<CpuProModule>;
    packagesTreeTimings: TreeTimings<CpuProPackage>;
    categoriesTreeTimings: TreeTimings<CpuProCategory>;

    callFramePositionsTimingsFiltered: DictionaryTimings<CpuProCallFramePosition> | null;
    callFramesTimingsFiltered: DictionaryTimings<CpuProCallFrame>;
    modulesTimingsFiltered: DictionaryTimings<CpuProModule>;
    packagesTimingsFiltered: DictionaryTimings<CpuProPackage>;
    categoriesTimingsFiltered: DictionaryTimings<CpuProCategory>;

    callFramePositionsTreeTimingsFiltered: TreeTimings<CpuProCallFramePosition> | null;
    callFramesTreeTimingsFiltered: TreeTimings<CpuProCallFrame>;
    modulesTreeTimingsFiltered: TreeTimings<CpuProModule>;
    packagesTreeTimingsFiltered: TreeTimings<CpuProPackage>;
    categoriesTreeTimingsFiltered: TreeTimings<CpuProCategory>;

    callFramePositionsTreeTimestamps: TreeTimestamps<CpuProCallFrame> | null;
    callFramesTreeTimestamps: TreeTimestamps<CpuProCallFrame>;
    modulesTreeTimestamps: TreeTimestamps<CpuProModule>;
    packagesTreeTimestamps: TreeTimestamps<CpuProPackage>;
    categoriesTreeTimestamps: TreeTimestamps<CpuProCategory>;
};

// Merging sequentially identical samples and coresponsing timeDeltas.
// Usually it allows to reduce number of samples for further processing at least by x2
export function mergeSamples(samples: Uint32Array, timeDeltas: Uint32Array, samplePositions: Int32Array | null) {
    const sampleCounts = new Uint32Array(samples.length).fill(1);
    let k = 1;

    if (samplePositions !== null) {
        for (let i = 1; i < samples.length; i++) {
            if (samples[i] !== samples[i - 1] || samplePositions[i] !== samplePositions[i - 1]) {
                timeDeltas[k] = timeDeltas[i];
                samples[k] = samples[i];
                samplePositions[k] = samplePositions[i];
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
            samplePositions: samplePositions !== null ? samplePositions.slice(0, k) : samplePositions,
            timeDeltas: timeDeltas.slice(0, k)
        }
        : {
            samples,
            sampleCounts,
            samplePositions,
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
    ...trees: CallTree<CpuProNode>[]
) {
    let sampleIdToNode = remapSamples(samples, sampleIdToEntryTreeNode);

    for (const tree of trees) {
        tree.sampleIdToNode = sampleIdToNode.map(id => tree.sourceIdToNode[id]);
        sampleIdToNode = tree.sampleIdToNode;
    }
}

export function computeTimings(
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    callFramesTree: CallTree<CpuProCallFrame>,
    modulesTree: CallTree<CpuProModule>,
    packagesTree: CallTree<CpuProPackage>,
    categoriesTree: CallTree<CpuProCategory>,
    callFramePositionsTree: CallTree<CpuProCallFramePosition> | null
): SamplesResult {
    // create timings
    const computeTimingsStart = Date.now();
    const kinds = callFramePositionsTree
        ? ['callFramePositions', 'callFrames', 'modules', 'packages', 'categories'] as const
        : ['callFrames', 'modules', 'packages', 'categories'] as const;
    const {
        recomputeTimings,
        samplesTimings,
        samplesTimingsFiltered,
        treeTimings,
        treeTimestamps,
        treeTimingsFiltered,
        dictionaryTimings,
        dictionaryTimingsFiltered
    } = createTreeCompute(samples, timeDeltas, [
        callFramePositionsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    ].filter(tree => tree !== null));

    const result = {
        recomputeTimings,
        samplesTimings,
        samplesTimingsFiltered,

        callFramePositionsTimings: null,
        callFramePositionsTreeTimings: null,
        callFramePositionsTimingsFiltered: null,
        callFramePositionsTreeTimingsFiltered: null,
        callFramePositionsTreeTimestamps: null
    };

    dictionaryTimings.forEach((timings, i) => result[`${kinds[i]}Timings`] = timings);
    treeTimings.forEach((timings, i) => result[`${kinds[i]}TreeTimings`] = timings);
    dictionaryTimingsFiltered.forEach((timings, i) => result[`${kinds[i]}TimingsFiltered`] = timings);
    treeTimingsFiltered.forEach((timings, i) => result[`${kinds[i]}TreeTimingsFiltered`] = timings);
    treeTimestamps.forEach((timings, i) => result[`${kinds[i]}TreeTimestamps`] = timings);

    TIMINGS && console.log('Compute timings:', Date.now() - computeTimingsStart);

    return result as SamplesResult;
}
