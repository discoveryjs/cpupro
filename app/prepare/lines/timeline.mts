import type { CreateProfileApi, Profile } from '../profile.mjs';
import type { SampledTree } from '../computations/metrics.js';
import type { Axis, Metric, ProfileLineTree, TimelineLine } from './types.js';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProOwner, CpuProPackage, V8CpuProfile } from '../types.js';
import { processLongTimeDeltas, createTimelineAxis } from '../preprocessing/time-deltas.js';
import { SampledCpuProCallTree, computeTreeMetrics } from '../preprocessing/samples.js';
import { reparentGcNodes } from '../preprocessing/gc-samples.js';
import { GeneratedNodes } from '../preprocessing/nodes.js';
import { convertToInt32Array, convertToUint32Array } from '../misc/utils.js';
import { createLineTree } from './trees.js';
import { noopWorkHandler, WorkHandler } from '../misc/work.js';

export type CreateTimelineOptions = {
    work: WorkHandler;
};

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

export async function extractTimelineData(
    data: V8CpuProfile,
    generateNodes: GeneratedNodes,
    options?: Partial<CreateTimelineOptions>
) {
    const {
        work = noopWorkHandler
    } = options || {};
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;

    if (profileType !== 'time') {
        return null;
    }

    // preprocess timeDeltas, fix order if necessary
    // FIXME: mutate samples/timeDeltas
    const axis = await work('process time deltas', () =>
        createTimelineAxis(
            data.startTime,
            data.endTime,
            data.timeDeltas,
            data._samplesInterval // could be computed on V8 log convertation into cpuprofile
        )
    );

    // normalize long samples (time deltas)
    // FIXME: mutate samples/timeDeltas
    if (experimentalFeatures) {
        await work('process time deltas', () =>
            processLongTimeDeltas(
                axis.samplesInterval,
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
        axis
    };
}

/**
 * Create timeline (CPU time profiling line) from processed profile data.
 * This is the primary line for CPU profiles, showing time-based metrics.
 */
export async function createTimeline(
    data: V8CpuProfile,
    axis: Axis,
    samples: Uint32Array,
    timeDeltas: Uint32Array,
    sampledTreeList: SampledCpuProCallTree[],
    { work }: CreateProfileApi
): Promise<TimelineLine | null> {
    const sourceInfo = {
        nodes: data.nodes.length,
        samples: data.samples.length,
        samplesInterval: data._samplesInterval || axis.samplesInterval
    };

    let sampledTreeOffset = 0;
    const sampledLocationsTree = sampledTreeList.length > 5
        ? sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProLocation>
        : null;
    const sampledCallFramesTree = sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProCallFrame>;
    const sampledModulesTree = sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProModule>;
    const sampledPackagesTree = sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProPackage>;
    const sampledCategoriesTree = sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProCategory>;
    const sampledOwnersTree = sampledTreeList[sampledTreeOffset++] as SampledTree<CpuProOwner>;

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
            sampledOwnersTree,
            sampledLocationsTree
        )
    );
    const lineTrees: ProfileLineTree[] = [];

    const line: TimelineLine = {
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

        axisStart: axis.start,
        axisStartNoSamples: axis.startNoSamples,
        axisEnd: axis.end,
        axisEndNoSamples: axis.endNoSamples,
        axisTotal: axis.total,

        values: timeDeltas,

        dict,
        tree,
        trees: lineTrees,

        mappings: Object.create(null)
    };

    lineTrees.push(createLineTree(
        'call-stack',
        line,
        { dict, tree },
        { samplesMetrics, samplesMetricsFiltered, recomputeMetrics }
    ));

    return line;
}
