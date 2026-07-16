import type { Profile } from '../profile.mjs';
import type { V8CpuProfile } from '../types.js';
import type { Metric, ProfileLineMethods, ProfileMemline } from './types.js';
import { SampledCpuProCallTree } from '../preprocessing/samples.js';
import { createVectorLocations } from '../preprocessing/locations.js';
import { ProfileScriptsMap } from '../preprocessing/scripts.js';
import { Dictionary } from '../dictionary.js';
import { noopWorkHandler, WorkHandler } from '../misc/work.js';
import { createMemlineCpuSamplesBreakdown } from './memline-cpu-samples-breakdown.mjs';
import { createMemlineLocationsBreakdown } from './memline-locations-breakdown.mjs';
import { sum } from '../misc/utils.js';
import {
    createMemlineAllocationCodeTypeAttribute,
    createMemlineAllocationLifespanAttribute,
    createMemlineAllocationSpaceAttribute,
    createMemlineAllocationTypeAttribute,
    createMemlineGcEpochAttribute
} from './memline-attributes.mjs';

export type CreateMemlineOptions = {
    work: WorkHandler;
};

const metricName: Record<Metric, string> = {
    axis: 'Memory allocated',
    samplingInterval: 'Sampling interval',
    selfValue: 'Self alloc',
    nestedValue: 'Nested alloc',
    totalValue: 'Total alloc'
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
    totalValue: 'The complete memory allocated by a function, including both \'self memory\' and \'nested memory\'.'
};
const memlineMethods: ProfileLineMethods = {
    formatValue(value: number, precision = 1): string {
        return `${(value / 1000).toFixed(precision)}Kb`;
    },
    valueWithUnit(value: number, precision = 1) {
        return {
            value: (value / 1000).toFixed(precision),
            unit: 'Kb'
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
 * Create memory allocation line from combined profile allocation data.
 * Maps allocation events to CPU samples, then uses CPU profile's trees to compute metrics.
 */
export async function createMemline(
    data: V8CpuProfile,
    dictionary: Dictionary,
    profileScriptsMap: ProfileScriptsMap,
    callStackTreeSet: {
        samples: Uint32Array<ArrayBufferLike>;
        sampledTrees: SampledCpuProCallTree[];
    },
    preparseScriptSourcesResult: Promise<void>,
    options?: Partial<CreateMemlineOptions>
): Promise<ProfileMemline | null> {
    const {
        work = noopWorkHandler
    } = options || {};
    const {
        _cpuproAllocationMapping,
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
    const allocationSizes = new Uint32Array(_cpuproAllocationSizes);

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

    // Calculate total allocation size as axis total
    const totalAllocationSize = sum(allocationSizes);

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
        createMemlineGcEpochAttribute(
            data._cpuproAllocationGc || null
        ),
        createMemlineAllocationLifespanAttribute(
            data._cpuproAllocationGc || null
        ),
        createMemlineAllocationCodeTypeAttribute(
            data._cpuproAllocationCodeType || null,
            data._cpuproAllocationCodeTypeNames || null,
            data._cpuproAllocationContextInfo || null
        )
    ].filter(attr => attr !== null));

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
        breakdowns: [],
        mappings: Object.create(null),

        // Important: The methods MUST be defined outside of the function to avoid retaining
        // the context of this function, which would prevent garbage collection of the temporary data
        // used to create the line.
        ...memlineMethods
    };

    if (_cpuproAllocationMapping && _cpuproAllocationIds) {
        const cpuSamplesBreakdown = await work('map allocations to CPU samples', () => {
            return createMemlineCpuSamplesBreakdown(
                'call-stack',
                line,
                _cpuproAllocationMapping,
                _cpuproAllocationIds,
                allocationSizes,
                callStackTreeSet,
                work
            );
        });

        line.breakdowns.push(cpuSamplesBreakdown);
    }

    // Wait for script sources to be parsed in a worker, so that they are available
    // for call frame resolution by line-column or script-offset.
    await work('parse script sources', () => preparseScriptSourcesResult);

    // Create vector of allocation locations for breakdown
    const vectorLocations = await work('create allocation locations vector', () =>
        createVectorLocations(
            dictionary,
            profileScriptsMap,
            _cpuproAllocationScriptIds,
            _cpuproAllocationLocations,
            _cpuproAllocationContextInfo,
            _cpuproAllocationVmStateNames,
            _cpuproAllocationBuiltinNames
        )
    );

    if (vectorLocations !== null) {
        const locationBreakdown = await work('create location breakdown', () =>
            createMemlineLocationsBreakdown(
                'location',
                line,
                dictionary,
                allocationSizes,
                vectorLocations,
                work
            )
        );

        line.breakdowns.push(locationBreakdown);
    }

    return line;
}
