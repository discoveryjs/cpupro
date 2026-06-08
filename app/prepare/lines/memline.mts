import type { CreateProfileApi, Profile } from '../profile.mjs';
import type { BuildTreeResult } from '../computations/build-trees.js';
import type { V8CpuProfile } from '../types.js';
import type { Metric, ProfileLineTree, ProfileMemline } from './types.js';
import { computeTreeMetrics, createSampledCallTree } from '../preprocessing/samples.js';
import { createVectorLocations } from '../preprocessing/locations.js';
import { sum } from '../misc/utils.js';
import { AllocationLifespan, typeColor } from '../const.js';
import { Dictionary } from '../dictionary.js';
import { ProfileScriptsMap } from '../preprocessing/scripts.js';
import { createLineTree } from './trees.js';

const metricName: Record<Metric, string> = {
    axis: 'Memory allocated',
    samplingInterval: 'Sampling interval',
    selfValue: 'Self memory',
    nestedValue: 'Nested memory',
    totalValue: 'Total memory'
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

/**
 * Create memory allocation line from combined profile allocation data.
 * Maps allocation events to CPU samples, then uses CPU profile's trees to compute metrics.
 */
export async function createMemline(
    data: V8CpuProfile,
    dictionary: Dictionary,
    scriptsMap: ProfileScriptsMap,
    cpuSamples: Uint32Array,
    locationsTree: BuildTreeResult['locationsTree'],
    callFramesTree: BuildTreeResult['callFramesTree'],
    modulesTree: BuildTreeResult['modulesTree'],
    packagesTree: BuildTreeResult['packagesTree'],
    categoriesTree: BuildTreeResult['categoriesTree'],
    sourceTree: ProfileLineTree | null,
    { work }: CreateProfileApi
): Promise<ProfileMemline | null> {
    const {
        _cpuproAllocationMapping,
        _cpuproAllocationIds,
        _cpuproAllocationSizes,
        _cpuproAllocationScriptIds = null,
        _cpuproAllocationLocations = null,
        _cpuproAllocationContextInfo = null,
        _cpuproAllocationBuiltinNames = null,
        _cpuproAllocationVmStateNames = null,
        _cpuproAllocationGc = null,
        _cpuproAllocationTypes = null,
        _cpuproAllocationTypeNames = null
    } = data;

    // Check if allocation data is present
    if (!_cpuproAllocationMapping || !_cpuproAllocationIds || !_cpuproAllocationSizes) {
        return null;
    }

    if (sourceTree === null || sourceTree.callFrames === null || sourceTree.modules === null || sourceTree.packages === null || sourceTree.categories === null) {
        return null;
    }

    const sourceLocationsTree = sourceTree.locations;
    const sourceCallFramesTree = sourceTree.callFrames;
    const sourceModulesTree = sourceTree.modules;
    const sourcePackagesTree = sourceTree.packages;
    const sourceCategoriesTree = sourceTree.categories;

    // Build allocation sample vector: map each allocation to its CPU sample node
    // _cpuproAllocationMapping[cpuSampleIdx] = last allocation ID when CPU sample taken
    // We need reverse: for each allocation, which CPU sample was it captured in?
    const allocationCount = _cpuproAllocationIds.length;
    const allocationSamples = new Uint32Array(allocationCount);
    const allocationSizes = new Uint32Array(allocationCount);
    let samplesInterval = _cpuproAllocationSizes[0];

    for (let i = 1; i < _cpuproAllocationSizes.length; i++) {
        if (_cpuproAllocationSizes[i] < samplesInterval) {
            samplesInterval = _cpuproAllocationSizes[i];
        }
    }

    await work('map allocations to CPU samples', () => {
        let allocIdx = 0;

        for (let cpuIdx = 0; cpuIdx < _cpuproAllocationMapping.length; cpuIdx++) {
            const targetAllocId = _cpuproAllocationMapping[cpuIdx];

            if (targetAllocId === undefined) {
                continue;
            }

            const cpuSample = cpuSamples[cpuIdx];

            // All allocations up to targetAllocId belong to this CPU sample
            while (allocIdx < allocationCount && _cpuproAllocationIds[allocIdx] <= targetAllocId) {
                allocationSamples[allocIdx] = cpuSample;
                allocationSizes[allocIdx] = _cpuproAllocationSizes[allocIdx] || 0;
                allocIdx++;
            }
        }
    });

    // Allocations don't have precise execution locations (script offsets)
    // The location tree will be null, metrics are aggregated by call frames only
    const {
        sampledLocationsTree,
        sampledCallFramesTree,
        sampledModulesTree,
        sampledPackagesTree,
        sampledCategoriesTree
    } = await work('prepare allocation tree mappings', () => ({
        sampledLocationsTree: locationsTree !== null
            ? createSampledCallTree(locationsTree, sourceLocationsTree?.sampleToNode || sourceCallFramesTree.sampleToNode)
            : null,
        sampledCallFramesTree: createSampledCallTree(callFramesTree, sourceCallFramesTree.sampleToNode),
        sampledModulesTree: createSampledCallTree(modulesTree, sourceModulesTree.sampleToNode),
        sampledPackagesTree: createSampledCallTree(packagesTree, sourcePackagesTree.sampleToNode),
        sampledCategoriesTree: createSampledCallTree(categoriesTree, sourceCategoriesTree.sampleToNode)
    }));

    // Now use computeTreeMetrics with CPU profile's trees to get full dimensions
    const {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dict,
        tree
    } = await work('compute memline metrics', () =>
        computeTreeMetrics(
            allocationSamples,
            allocationSizes,
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

    const vectorLocations = createVectorLocations(
        dictionary,
        scriptsMap,
        _cpuproAllocationScriptIds,
        _cpuproAllocationLocations,
        _cpuproAllocationContextInfo,
        _cpuproAllocationBuiltinNames,
        _cpuproAllocationVmStateNames,
        samplesMetrics,
        samplesMetricsFiltered
    );

    // Calculate total allocation size as axis total
    const totalAllocationSize = sum(allocationSizes);

    // Allocation types
    let allocationTypeVector: Uint32Array | null = null;
    let allocationTypeNames: string[] | null = null;
    if (_cpuproAllocationTypes) {
        const map = new Map<number, number>();

        allocationTypeVector = new Uint32Array(_cpuproAllocationTypes);
        allocationTypeNames = Object.entries(_cpuproAllocationTypeNames || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([id, name]) => {
                map.set(Number(id), map.size);
                return name.replace(/_TYPE$/, '');
            });

        for (let i = 0; i < allocationTypeVector.length; i++) {
            allocationTypeVector[i] = map.get(allocationTypeVector[i]) || 0;
        }
    }

    // Allocation spaces
    let allocationSpaces: Uint32Array | null = null;
    let allocationSpaceNames: string[] | null = null;
    if (data._cpuproAllocationSpaces) {
        const map = new Map<number, number>();

        allocationSpaces = new Uint32Array(data._cpuproAllocationSpaces);
        allocationSpaceNames = Object.entries(data._cpuproAllocationSpaceNames || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([id, name]) => {
                map.set(Number(id), map.size);
                return name.replace(/large_object_/, 'lo_');
            });

        for (let i = 0; i < allocationSpaces.length; i++) {
            allocationSpaces[i] = map.get(allocationSpaces[i]) || 0;
        }
    }

    // GC states
    let allocationGcEpochs: Uint32Array | null = null;
    let allocationGcEpochDict: ProfileMemline['valueGcEpochsDict'] = null;
    let allocationLifespans: Uint8Array | null = null;
    const allocationLifespanDict: AllocationLifespan[] = ['alive', 'short-lived', 'long-lived'];
    if (_cpuproAllocationGc) {
        const epochs = new Set<number>(_cpuproAllocationGc);
        const epochToIndex = new Map<number, number>();

        allocationGcEpochDict = [];
        for (const epoch of [...epochs].sort((a, b) => a - b)) {
            epochToIndex.set(epoch, epochToIndex.size);
            allocationGcEpochDict.push({
                type: epoch === 0 ? 'none' : epoch & 1 ? 'minor' : 'major',
                epoch: epoch >> 2,
                color: typeColor[epoch === 0 ? 'alive' : epoch & 1 ? 'short-lived' : 'long-lived']
            });
        }

        allocationGcEpochs = Uint32Array.from(_cpuproAllocationGc, gc => epochToIndex.get(gc)!);
        allocationLifespans = Uint8Array.from(_cpuproAllocationGc, gc => gc & 3);
    }

    return {
        // data,
        type: 'memline',
        kind: 'memory' as const,
        profile: null as unknown as Profile, // to be set by caller
        sourceInfo: {
            nodes: 0, // Allocation events don't have nodes (they reference CPU nodes)
            samples: allocationCount,
            samplesInterval
        },

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
        },

        axisStart: 0,
        axisStartNoSamples: 0,
        axisEnd: totalAllocationSize,
        axisEndNoSamples: totalAllocationSize,
        axisTotal: totalAllocationSize,

        values: samplesMetrics.values,
        samples: samplesMetrics.samples,
        samplesMetrics,
        samplesMetricsFiltered,
        recomputeMetrics: recomputeMetrics,

        dict,
        tree,
        trees: lineTrees,
        locations: vectorLocations,

        mappings: Object.create(null),

        // memline-specific properties
        valueTypes: allocationTypeVector,
        valueTypesDict: allocationTypeNames,
        valueGcEpochs: allocationGcEpochs,
        valueGcEpochsDict: allocationGcEpochDict,
        valueLifespans: allocationLifespans,
        valueLifespansDict: allocationLifespanDict,
        valueSpaces: allocationSpaces,
        valueSpacesDict: allocationSpaceNames,

        // experimental cross-profile properties
        // _commonTree: null as unknown,
        _uniqueValuesMap: new Map(),
        _uniqueValuesArray: new Array<number>(),
        _callFramesMap: new Map(),
        _callFramesVariance: new Uint32Array(),
        _callFramesStable: new Uint32Array(),
        _samplesAll: new Uint32Array(),
        _samplesStable: new Uint32Array()
    };
}
