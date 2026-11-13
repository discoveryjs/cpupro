import type { Profile } from '../profile.mjs';
import type { CpuProCompilationRecord, V8CpuProfile } from '../types.js';
import type { Metric, ProfileLineAttribute, ProfileLineMethods, ProfileMemline } from './types.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
import { computeCumulative, computeCumulativeEnd, type Population } from '../computations/population.js';
import type { SourceMapping } from '../preprocessing/source-mapping.js';
import { createVectorLocations } from '../preprocessing/locations.js';
import { ProfileScriptsMap } from '../preprocessing/scripts.js';
import { Dictionary } from '../dictionary.js';
import { noopWorkHandler, WorkHandler } from '../misc/work.js';
import { createMemlineCpuSamplesBreakdown } from './memline-cpu-samples-breakdown.mjs';
import { createMemlineLocationsBreakdown } from './memline-locations-breakdown.mjs';
import { createEventClasses } from './event-signatures.js';
import { createAttributeFilter } from './filters/attribute.js';
import { asInt32Array, asUint32Array, fractionDigits } from '../misc/utils.js';
import { stepFractionDigits } from '../misc/time-utils.js';
import { FilterSet } from '../computations/filter-set.js';
import { RangeSelection, RangeView } from '../computations/range.js';
import {
    createMemlineAllocationCodeTypeAttribute,
    createMemlineAllocationSpaceAttribute,
    createMemlineAllocationTypeAttribute,
    createMemlineCompilationAttributes,
    createMemlineGcAttributes
} from './memline-attributes.mjs';

export type CreateMemlineOptions = {
    work: WorkHandler;
    compilations: CpuProCompilationRecord[] | null;
    sourceMapping: SourceMapping | null;
};

const metricName: Record<Metric, string> = {
    axis: 'Memory allocated',
    samplingInterval: 'Sampling interval',
    selfValue: 'Self alloc',
    nestedValue: 'Nested alloc',
    totalValue: 'Total alloc',
    interval: 'Memory allocated'
};
const metricDefinitions: Record<Metric, string> = {
    axis: [
        'The total memory allocated during the profiling session, excluding any memory allocations that occurred before the first sample and after the last sample, which are periods with no samples. The total allocated memory is calculated by summing the sizes of all captured allocation events and is used as the basis for computing memory usage percentages.',
        'The memory allocated before the first sample represents the overhead of the profiling session start-up, which is minimal if profiling begins at program start but may be longer if initiated during program execution.',
        'The memory allocated after the last sample is typically zero unless it includes overhead from concluding the profiling session or adjustments from excluding idle samples at the end.',
        '- Profiling session memory: `{{primaryLine.axisEnd - primaryLine.axisStart | ms()}}`',
        '- Memory before first sample: `{{primaryLine.axisStartNoSamples | ms()}}`',
        '- Memory after last sample: `{{primaryLine.axisEndNoSamples | ms()}}`',
        '- Profiling memory:<br>`{{primaryLine.axisEnd - primaryLine.axisStart | ms()}}` – `{{primaryLine.axisStartNoSamples | ms()}}` – `{{primaryLine.axisEndNoSamples | ms()}}` = `{{primaryLine.axisTotal | ms()}}`'
    ].join('\n'),
    samplingInterval: 'The minimum memory allocated between samples taken during the profiling session.',
    selfValue: 'The memory allocated by a function\'s own code, excluding any memory allocated by other functions it calls.',
    nestedValue: 'The memory allocated by functions that are called by a given function, excluding the memory taken during the original function\'s own code execution.',
    totalValue: 'The complete memory allocated by a function, including both \'self memory\' and \'nested memory\'.',
    interval: 'The memory allocated during a specific range.'
};
const memlineMethods: ProfileLineMethods = {
    formatValue(value: number, resolution = 100): string {
        return `${(value / 1000).toFixed(fractionDigits(resolution, 1000))}Kb`;
    },
    valueWithUnit(value: number, resolution = 100) {
        return {
            value: (value / 1000).toFixed(fractionDigits(resolution, 1000)),
            unit: 'Kb'
        };
    },
    formatScaleValue(value: number, scaleLength: number, step?: number): string {
        const unit = scaleLength < 1_000_000 ? 1_000 : 1_000_000;
        const scaled = step !== undefined
            ? (value / unit).toFixed(stepFractionDigits(step, unit))
            : (value / unit).toFixed(1).replace(/\.0$/, '');

        return `${scaled}${unit === 1_000 ? 'Kb' : 'Mb'}`;
    },
    metricName(metric: Metric): string {
        return metricName[metric];
    },
    metricDefinition(metric: Metric): string {
        return metricDefinitions[metric];
    }
};

/**
 * Create memory allocation line from combined profile allocation data.
 * Maps allocation events to CPU samples, then uses CPU profile's trees to compute metrics.
 */
export async function createMemline(
    data: V8CpuProfile,
    dictionary: Dictionary,
    profileScriptsMap: ProfileScriptsMap,
    cpuPopulation: Population | null,
    callStackTreeSet: SampledTreeSet | null,
    allocationSamples: Uint32Array | null, // per allocation: the index of its CPU sample
    preparseScriptSourcesResult: Promise<void>,
    options?: Partial<CreateMemlineOptions>
): Promise<ProfileMemline | null> {
    const {
        work = noopWorkHandler,
        compilations = null,
        sourceMapping = null
    } = options || {};
    const {
        _cpuproAllocationIds,
        _cpuproAllocationSizes,
        _cpuproAllocationScriptIds = null,
        _cpuproAllocationLocations = null,
        _cpuproAllocationContextInfo = null,
        _cpuproAllocationBuiltinNames = null,
        _cpuproAllocationVmStateNames = null
    } = data;

    // Check if allocation data is present
    if (!_cpuproAllocationSizes) {
        return null;
    }

    // const vmstate = new Uint32Array(16);
    // const builtins = new Map();
    // let internals = 0;
    // for (let i = 0; i < _cpuproAllocationContextInfo!.length; i++) {
    //     vmstate[_cpuproAllocationContextInfo![i] & 0x0f] += _cpuproAllocationSizes![i];
    //     if (_cpuproAllocationContextInfo![i] > 0x0f) {
    //         internals += _cpuproAllocationSizes![i];
    //         const id = _cpuproAllocationContextInfo![i] >> 4;
    //         builtins.set(id, (builtins.get(id) || 0) + _cpuproAllocationSizes![i]);
    //     }
    // }
    // console.log('Internals', internals);
    // for (let i = 0; i < vmstate.length; i++) {
    //     if (vmstate[i] > 0) {
    //         console.log(_cpuproAllocationVmStateNames![i], vmstate[i]);
    //     }
    // }
    // console.log('Builtins:');
    // for (const [id, size] of [...builtins.entries()].sort((a, b) => b[1] - a[1])) {
    //     console.log(`  ${_cpuproAllocationBuiltinNames![id]}: ${size}`);
    // }

    // Convert allocation sizes to typed array for faster processing
    const allocationSizes = asUint32Array(_cpuproAllocationSizes);

    let samplesInterval = allocationSizes[0];
    for (let i = 1; i < allocationSizes.length; i++) {
        if (allocationSizes[i] < samplesInterval) {
            samplesInterval = allocationSizes[i];
        }
    }

    // Exclude GCed allocations from size
    // if (data._cpuproAllocationGc) {
    //     for (let i = 0; i < allocationSizes.length; i++) {
    //         if (data._cpuproAllocationGc![i] > 0) {
    //             allocationSizes[i] = 0;
    //         }
    //     }
    // }

    // Populations of the memline share the prefix sums of allocation sizes; their end is the axis total
    const cumulative = await work('compute memline cumulative sizes', () =>
        computeCumulative(allocationSizes)
    );
    const totalAllocationSize = computeCumulativeEnd(allocationSizes, cumulative);

    // Memline attributes
    const attributes = await work('create memline attributes', () => [
        createMemlineAllocationTypeAttribute(
            data._cpuproAllocationTypes || null,
            data._cpuproAllocationTypeNames || null
        ),
        createMemlineAllocationSpaceAttribute(
            data._cpuproAllocationSpaces || null,
            data._cpuproAllocationSpaceNames || null
        ),
        ...createMemlineGcAttributes(
            data._cpuproAllocationGc || null,
            data._cpuproAllocationGcIds || null,
            _cpuproAllocationIds || null,
            data._cpuproAllocationIdsOrder || null
        ),
        createMemlineAllocationCodeTypeAttribute(
            data._cpuproAllocationCodeType || null,
            data._cpuproAllocationCodeTypeNames || null,
            data._cpuproAllocationContextInfo || null
        ),
        ...createMemlineCompilationAttributes(
            compilations,
            _cpuproAllocationIds || null,
            data._cpuproAllocationIdsOrder || null
        )
    ].filter(attr => attr !== null));

    // Populations of the memline share the classes of allocations with equal values of every event filter.
    // A lifespan is the low bits of a GC value and an entry of GC epochs is a whole GC value, whether attributes come
    // from a vector of GC values or from lists of traces, so the GC epoch of an allocation gives its lifespan:
    // lifespans split no class of GC epochs and take no pass of their own
    const hasEventFilter = (attribute: ProfileLineAttribute) =>
        createAttributeFilter(attribute, allocationSizes.length) !== null;
    const filteredAttributes = attributes.filter(hasEventFilter);
    const hasGcEpoch = filteredAttributes.some(attribute => attribute.name === 'allocationGcEpoch');
    const isImplied = (attribute: ProfileLineAttribute) =>
        hasGcEpoch && attribute.name === 'allocationLifespan';
    const isCombined = (attribute: ProfileLineAttribute) => !isImplied(attribute);
    const eventClasses = await work('compute memline event classes', () =>
        createEventClasses(
            allocationSizes.length,
            filteredAttributes.filter(isCombined),
            filteredAttributes.filter(isImplied)
        )
    );

    const range = new RangeSelection({ name: 'cumulative-allocated-bytes', unit: 'bytes' })
        .view({ start: 0, end: totalAllocationSize });
    const line: ProfileMemline = {
        type: 'memline',
        kind: 'memory' as const,
        profile: null as unknown as Profile, // to be set by caller
        sourceInfo: {
            nodes: 0, // Allocation events don't have nodes (they reference CPU nodes)
            samples: _cpuproAllocationSizes.length,
            samplesInterval
        },

        axisStart: 0,
        axisStartNoSamples: 0,
        axisEnd: totalAllocationSize,
        axisEndNoSamples: totalAllocationSize,
        axisTotal: totalAllocationSize,

        values: allocationSizes,
        attributes,
        eventClasses,
        filters: new FilterSet(),
        viewport: new RangeView(new RangeSelection(range.selection.space), range.frame, range.extent),
        zoom: new RangeView(new RangeSelection(range.selection.space), range.frame, range.extent),
        window: new RangeView(new RangeSelection(range.selection.space), range.frame, range.extent),
        range,
        breakdowns: [],
        mappings: Object.create(null),
        signatures: null,

        // Important: The methods MUST be defined outside of the function to avoid retaining
        // the context of this function, which would prevent garbage collection of the temporary data
        // used to create the line.
        ...memlineMethods
    };

    if (cpuPopulation && callStackTreeSet && allocationSamples) {
        const cpuSamplesBreakdown = await work('attribute allocations to CPU call stacks', () => {
            return createMemlineCpuSamplesBreakdown(
                'call-stack',
                line,
                allocationSamples,
                allocationSizes,
                cumulative,
                cpuPopulation,
                callStackTreeSet,
                work
            );
        });

        line.breakdowns.push(cpuSamplesBreakdown);
    }

    // Wait for script sources to be parsed in a worker, so that they are available
    // for call frame resolution by line-column or script-offset.
    await work('parse script sources', () => preparseScriptSourcesResult);

    // Locations take typed vectors, so allocation vectors given as plain arrays are converted as sizes are
    const allocationScriptIds = _cpuproAllocationScriptIds !== null
        ? asUint32Array(_cpuproAllocationScriptIds)
        : null;
    const allocationScriptOffsets = _cpuproAllocationLocations !== null
        ? asInt32Array(_cpuproAllocationLocations)
        : null;
    const allocationContextInfo = _cpuproAllocationContextInfo !== null
        ? asUint32Array(_cpuproAllocationContextInfo)
        : null;

    // Create vector of allocation locations for breakdown
    const vectorLocations = await work('create allocation locations vector', () =>
        createVectorLocations(
            dictionary,
            profileScriptsMap,
            allocationScriptIds,
            allocationScriptOffsets,
            allocationContextInfo,
            _cpuproAllocationVmStateNames,
            _cpuproAllocationBuiltinNames
        )
    );

    // Original sources of the allocation locations are parsed while the rest of the profile is created
    if (sourceMapping !== null && vectorLocations !== null) {
        await work('prepare source maps', () =>
            sourceMapping.prepareLocations(vectorLocations)
        );
    }

    const locationBreakdown = vectorLocations !== null
        ? await work('create location breakdown', () =>
            createMemlineLocationsBreakdown(
                'location',
                line,
                dictionary,
                allocationSizes,
                cumulative,
                vectorLocations,
                work
            )
        )
        : null;

    if (locationBreakdown !== null) {
        line.breakdowns.push(locationBreakdown);
    }

    return line;
}
