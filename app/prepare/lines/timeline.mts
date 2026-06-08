import type { CreateProfileApi, Profile } from '../profile.mjs';
import type { BuildTreeResult } from '../computations/build-trees.js';
import type { Metric, TimelineLine } from './types.js';
import { remapTreeSamples, type CpuProCallTree, type SampledCallTree } from '../preprocessing/samples.js';
import { computeTreeMetrics } from '../preprocessing/samples.js';
import { processLongTimeDeltas, processTimeDeltas } from '../preprocessing/time-deltas.js';
import { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProPackage, GeneratedNodes, V8CpuProfile } from '../types.js';
import { convertToInt32Array, convertToUint32Array } from '../misc/utils.js';
import { reparentGcNodes } from '../preprocessing/gc-samples.js';
import { createLineTree } from './trees.js';

const experimentalFeatures = false;
const metricName: Record<Metric, string> = {
    axis: 'Profiling time',
    samplingInterval: 'Sampling interval',
    selfValue: 'Self time',
    nestedValue: 'Nested time',
    totalValue: 'Total time'
};
const metricDefinitions: Record<Metric, string> = {
    axis: [
        'The time of the profiling session, excluding the time before the first sample and after the last sample, which are periods with no samples. The total profiling time is calculated by summing the durations of all captured samples and is used as the basis for computing time percentages.',
        'The time before the first sample represents the start-up overhead of the profiling session, which is minimal if profiling begins at program start but may be longer if initiated during program execution.',
        'The time after the last sample is typically zero unless it includes overhead from concluding the profiling session or adjustments from excluding idle samples at the end.',
        '- Profiling session time: `{{primaryLine.axisEnd - primaryLine.axisStart | ms()}}`',
        '- Time before first sample: `{{primaryLine.axisStartNoSamples | ms()}}`',
        '- Time after last sample: `{{primaryLine.axisEndNoSamples | ms()}}`',
        '- Profiling time:<br>`{{primaryLine.axisEnd - primaryLine.axisStart | ms()}}` – `{{primaryLine.axisStartNoSamples | ms()}}` – `{{primaryLine.axisEndNoSamples | ms()}}` = `{{primaryLine.axisTotal | ms()}}`'
    ].join('\n'),
    samplingInterval: '',
    selfValue: 'The time spent executing a function\'s own code, excluding any time used by other functions it calls.',
    nestedValue: 'The time accounted for the execution of functions that are called by a given function, excluding the time taken to execute the original function\'s own code itself.',
    totalValue: 'The complete time taken to execute a function. It includes both \'self time\', which is the time the function spends executing its own code, and \'nested time\', which is the time spent executing all other functions that are called from within this function.'
};

export interface TimelineSourceInfo {
    nodes: number;
    samples: number;
    samplesInterval: number;
}

export interface TimelineAxisInfo {
    start: number;
    startNoSamples: number;
    end: number;
    endNoSamples: number;
    total: number;
}

export interface TimelineSamplesData {
    samples: Uint32Array;
    sampleLocations: Int32Array | null;
    values: Uint32Array;  // timeDeltas
}

export interface TimelineTreesData {
    locationsTreeSource: { sourceIdToNode: Int32Array } | null;
    treeSource: BuildTreeResult['treeSource'];
    locationsTree: BuildTreeResult['locationsTree'];
    callFramesTree: BuildTreeResult['callFramesTree'];
    modulesTree: BuildTreeResult['modulesTree'];
    packagesTree: BuildTreeResult['packagesTree'];
    categoriesTree: BuildTreeResult['categoriesTree'];
}

export async function extractTimelineData(
    data: V8CpuProfile,
    generateNodes: GeneratedNodes,
    { work }: CreateProfileApi
) {
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;

    if (profileType !== 'time') {
        return null;
    }

    // preprocess timeDeltas, fix order if necessary
    // FIXME: mutate samples/timeDeltas
    const {
        startTime: axisStart,
        startNoSamplesTime: axisStartNoSamples,
        endTime: axisEnd,
        endNoSamplesTime: axisEndNoSamples,
        totalTime: axisTotal,
        samplesInterval
    } = await work('process time deltas', () =>
        processTimeDeltas(
            data.startTime,
            data.endTime,
            data.timeDeltas,
            data.samples,
            data._samplePositions,
            data._samplesInterval // could be computed on V8 log convertation into cpuprofile
        )
    );

    // normalize long samples (time deltas)
    // FIXME: mutate samples/timeDeltas
    if (experimentalFeatures) {
        await work('process time deltas', () =>
            processLongTimeDeltas(
                samplesInterval,
                data.timeDeltas,
                data.samples,
                data._samplePositions,
                generateNodes
            )
        );
    }

    // ============================================================================
    // Convert samples & timeDeltas into TypedArrays (fixed length)
    // ============================================================================

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    const {
        samples,
        // timeDeltas,
        sampleLocations
    } = await work('convert samples & timeDeltas into TypedArrays', () => ({
        samples: convertToUint32Array(data.samples),
        timeDeltas: convertToUint32Array(data.timeDeltas),
        sampleLocations: Array.isArray(data._samplePositions)
            ? convertToInt32Array(data._samplePositions)
            : null
    }));

    // attach root GC node samples to previous call stack;
    // this operation produces new nodes
    await work('reparent GC samples', () =>
        reparentGcNodes(
            data.nodes,
            generateNodes,
            data._callFrames || null,
            samples,
            sampleLocations
        )
    );


    return {
        axis: {
            axisStart,
            axisStartNoSamples,
            axisEnd,
            axisEndNoSamples,
            axisTotal
        }
    };
}

/**
 * Create timeline (CPU time profiling line) from processed profile data.
 * This is the primary line for CPU profiles, showing time-based metrics.
 */
export async function createTimeline(
    sourceInfo: TimelineSourceInfo,
    axisInfo: TimelineAxisInfo,
    samplesData: TimelineSamplesData,
    trees: TimelineTreesData,
    { work }: CreateProfileApi
): Promise<TimelineLine | null> {
    const {
        locationsTreeSource,
        treeSource,
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = trees;

    const {
        samples,
        values: timeDeltas
    } = samplesData;

    const callTrees = [
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    ].filter(tree => tree !== null) as CpuProCallTree[];

    // ============================================================================
    // Re-map samples FIRST (sets up line-owned sample-to-node mappings)
    // ============================================================================

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    const sampledTreeList = await work('remap samples', () =>
        remapTreeSamples(
            samples,
            locationsTreeSource?.sourceIdToNode || treeSource.sourceIdToNode,
            callTrees
        )
    );
    let sampledTreeOffset = 0;
    const sampledLocationsTree = locationsTree !== null
        ? sampledTreeList[sampledTreeOffset++] as SampledCallTree<CpuProLocation>
        : null;
    const sampledCallFramesTree = sampledTreeList[sampledTreeOffset++] as SampledCallTree<CpuProCallFrame>;
    const sampledModulesTree = sampledTreeList[sampledTreeOffset++] as SampledCallTree<CpuProModule>;
    const sampledPackagesTree = sampledTreeList[sampledTreeOffset++] as SampledCallTree<CpuProPackage>;
    const sampledCategoriesTree = sampledTreeList[sampledTreeOffset++] as SampledCallTree<CpuProCategory>;

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
            timeDeltas,
            sampledCallFramesTree,
            sampledModulesTree,
            sampledPackagesTree,
            sampledCategoriesTree,
            sampledLocationsTree
        )
    );
    const lineTrees = [createLineTree(
        'call-stack',
        {
            locations: sampledLocationsTree,
            callFrames: sampledCallFramesTree,
            modules: sampledModulesTree,
            packages: sampledPackagesTree,
            categories: sampledCategoriesTree
        },
        { dict, tree }
    )];

    return {
        type: 'timeline',
        kind: 'time' as const,
        profile: null as unknown as Profile, // to be set by caller
        sourceInfo,

        formatValue(value: number, precision = 1) {
            return `${(value / 1000).toFixed(precision)} ms`;
        },
        valueWithUnit(value: number, precision = 1) {
            return {
                value: (value / 1000).toFixed(precision),
                unit: 'ms'
            };
        },
        metricName(metric: Metric): string {
            return metricName[metric];
        },
        metricDefinition(metric: Metric): string {
            return metricDefinitions[metric];
        },

        axisStart: axisInfo.start,
        axisStartNoSamples: axisInfo.startNoSamples,
        axisEnd: axisInfo.end,
        axisEndNoSamples: axisInfo.endNoSamples,
        axisTotal: axisInfo.total,

        values: samplesMetrics.values,
        samples: samplesMetrics.samples,
        samplesMetrics,
        samplesMetricsFiltered,
        recomputeMetrics: recomputeMetrics,

        dict,
        tree,
        trees: lineTrees,
        locations: null,

        mappings: Object.create(null)
    };
}
