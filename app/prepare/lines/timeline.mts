import type { Profile } from '../profile.mjs';
import type { Axis, Metric, ProfileLineMethods, TimelineLine } from './types.js';
import type { V8CpuProfile } from '../types.js';
import { SampledCpuProCallTree } from '../preprocessing/samples.js';
import { createLineBreakdown } from './trees.js';
import { noopWorkHandler, WorkHandler } from '../misc/work.js';

export type CreateTimelineOptions = {
    work: WorkHandler;
};

const metricName: Record<Metric, string> = {
    axis: 'Profiling time',
    samplingInterval: 'Sampling interval',
    selfValue: 'Self time',
    nestedValue: 'Nested time',
    totalValue: 'Total time',
    interval: 'Duration'
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
    totalValue: 'The complete time taken to execute a function. It includes both \'self time\', which is the time the function spends executing its own code, and \'nested time\', which is the time spent executing all other functions that are called from within this function.',
    interval: 'The time duration of a specific range.'
};
const timelineMethods: ProfileLineMethods = {
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
    }
};

/**
 * Create timeline (CPU time profiling line) from processed profile data.
 * This is the primary line for CPU profiles, showing time-based metrics.
 */
export async function createTimeline(
    data: V8CpuProfile,
    axis: Axis,
    timeDeltas: Uint32Array,
    sampledTreeSet: {
        samples: Uint32Array<ArrayBufferLike>;
        sampledTrees: SampledCpuProCallTree[];
    },
    options: CreateTimelineOptions
): Promise<TimelineLine | null> {
    const {
        work = noopWorkHandler
    } = options || {};
    const sourceInfo = {
        nodes: data.nodes.length,
        samples: data.samples.length,
        samplesInterval: data._samplesInterval || axis.samplesInterval
    };

    const line: TimelineLine = {
        type: 'timeline',
        kind: 'time' as const,
        profile: null as unknown as Profile, // to be set by caller
        sourceInfo,

        axisStart: axis.start,
        axisStartNoSamples: axis.startNoSamples,
        axisEnd: axis.end,
        axisEndNoSamples: axis.endNoSamples,
        axisTotal: axis.total,

        values: timeDeltas,
        attributes: [],
        breakdowns: [],
        mappings: Object.create(null),

        // Important: The methods MUST be defined outside of the function to avoid retaining
        // the context of this function, which would prevent garbage collection of the temporary data
        // used to create the line.
        ...timelineMethods
    };

    const callStackBreakdown = await createLineBreakdown(
        'call-stack',
        line,
        timeDeltas,
        sampledTreeSet,
        work
    );
    line.breakdowns.push(callStackBreakdown);
    line.values = callStackBreakdown.samplesMetricsFiltered.samples;

    return line;
}
