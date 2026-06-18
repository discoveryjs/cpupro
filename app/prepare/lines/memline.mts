import { createSampledTreeSet, type Profile } from '../profile.mjs';
import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProOwner, CpuProPackage, V8CpuProfile } from '../types.js';
import type { Metric, ProfileLineTree, ProfileMemline } from './types.js';
import { computeTreeMetrics, SampledCpuProCallTree } from '../preprocessing/samples.js';
import { createVectorLocations } from '../preprocessing/locations.js';
import { ProfileScriptsMap } from '../preprocessing/scripts.js';
import { AllocationLifespan, typeColor } from '../const.js';
import { sum } from '../misc/utils.js';
import { Dictionary } from '../dictionary.js';
import { createLineTree } from './trees.js';
import { SampledTree } from '../computations/metrics.js';
import type { GeneratedNodes } from '../preprocessing/nodes.js';
import type { TreeSource } from '../computations/build-trees.js';
import { noopWorkHandler, WorkHandler } from '../misc/work.js';

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

function createAllocationLocationBreakdownBasis(
    dictionary: Dictionary,
    generatedNodes: GeneratedNodes
): TreeSource<CpuProLocation> {
    const nodeIndexById = Int32Array.from({ length: generatedNodes.count }, (_, index) => index);
    const nodeParent = Uint32Array.from(generatedNodes.nodeParentId);
    const locationNodes = new Uint32Array(generatedNodes.parentScriptOffsets); // parentScriptOffsets used to store location indices

    debugger;
    return {
        parent: nodeParent,
        sourceIdToNode: nodeIndexById,
        nodes: locationNodes,
        dictionary: dictionary.locations
    };

    // call frames
    // const callFrameByNodeIndex = Uint32Array.from(generatedNodes.callFrames);
    // {
    //     nodeParent,
    //     nodeIndexById,
    //     callFrameByNodeIndex,
    //     dictionary: dictionary.callFrames
    // }
}

/**
 * Create memory allocation line from combined profile allocation data.
 * Maps allocation events to CPU samples, then uses CPU profile's trees to compute metrics.
 */
export async function createMemline(
    data: V8CpuProfile,
    dictionary: Dictionary,
    profileScriptsMap: ProfileScriptsMap,
    cpuSampledTreeSet: {
        samples: Uint32Array<ArrayBufferLike>;
        sampledTrees: SampledCpuProCallTree[];
    },
    options?: Partial<CreateMemlineOptions>
): Promise<ProfileMemline | null> {
    const {
        work = noopWorkHandler
    } = options || {};
    const {
        samples: cpuSamples,
        sampledTrees: sampledTreeList
    } = cpuSampledTreeSet;
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

    // Build allocation sample vector: map each allocation to its CPU sample node
    // _cpuproAllocationMapping[cpuSampleIdx] = last allocation ID when CPU sample taken
    // We need reverse: for each allocation, which CPU sample was it captured in?
    const allocationCount = _cpuproAllocationIds.length;
    const allocationCpuSamples = new Uint32Array(allocationCount);
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
                allocationCpuSamples[allocIdx] = cpuSample;
                allocationSizes[allocIdx] = _cpuproAllocationSizes[allocIdx] || 0;
                allocIdx++;
            }
        }
    });

    let memlineSampledTreeOffset = 0;
    const memlineSampledLocationsTree = sampledTreeList.length > 5
        ? sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProLocation>
        : null;
    const memlineSampledCallFramesTree = sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProCallFrame>;
    const memlineSampledModulesTree = sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProModule>;
    const memlineSampledPackagesTree = sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProPackage>;
    const memlineSampledCategoriesTree = sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProCategory>;
    const memlineSampledOwnersTree = sampledTreeList[memlineSampledTreeOffset++] as SampledTree<CpuProOwner>;

    // Now use computeTreeMetrics with memline's compact sample domain to get full dimensions
    const {
        recomputeMetrics,
        samplesMetrics,
        samplesMetricsFiltered,
        dict,
        tree
    } = await work('compute memline metrics', () =>
        computeTreeMetrics(
            allocationCpuSamples,
            allocationSizes,
            memlineSampledCallFramesTree,
            memlineSampledModulesTree,
            memlineSampledPackagesTree,
            memlineSampledCategoriesTree,
            memlineSampledOwnersTree,
            memlineSampledLocationsTree
        )
    );

    const vectorLocations = await work('create vector locations', () =>
        createVectorLocations(
            dictionary,
            profileScriptsMap,
            _cpuproAllocationScriptIds,
            _cpuproAllocationLocations,
            _cpuproAllocationContextInfo,
            _cpuproAllocationBuiltinNames,
            _cpuproAllocationVmStateNames
        )
    );

    let allocationLocationBreakdownBasis: TreeSource<CpuProLocation> | null = null;
    const allocationLocationMetrics = vectorLocations !== null
        ? await work('compute memline location metrics', async () => {
            allocationLocationBreakdownBasis = createAllocationLocationBreakdownBasis(
                dictionary,
                vectorLocations.generatedNodes
            );
            const locationTreeSamples = await createSampledTreeSet(
                dictionary,
                allocationLocationBreakdownBasis,
                vectorLocations.samples,
                work
            );

            if (locationTreeSamples === null) {
                return null;
            }

            const [
                allocationLocationsTree,
                allocationCallFramesTree,
                allocationModulesTree,
                allocationPackagesTree,
                allocationCategoriesTree,
                allocationOwnersTree
            ] = locationTreeSamples.sampledTreeList;

            return computeTreeMetrics(
                vectorLocations.sampleToNode,
                allocationSizes,
                allocationCallFramesTree as SampledTree<CpuProCallFrame>,
                allocationModulesTree as SampledTree<CpuProModule>,
                allocationPackagesTree as SampledTree<CpuProPackage>,
                allocationCategoriesTree as SampledTree<CpuProCategory>,
                allocationOwnersTree as SampledTree<CpuProOwner>,
                allocationLocationsTree as SampledTree<CpuProLocation>
            );
        })
        : null;

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

    const lineTrees: ProfileLineTree[] = [];
    const line: ProfileMemline = {
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

        values: allocationSizes,

        dict,
        tree,
        trees: lineTrees,

        mappings: Object.create(null),

        // memline-specific properties
        valueTypes: allocationTypeVector,
        valueTypesDict: allocationTypeNames,
        valueGcEpochs: allocationGcEpochs,
        valueGcEpochsDict: allocationGcEpochDict,
        valueLifespans: allocationLifespans,
        valueLifespansDict: allocationLifespanDict,
        valueSpaces: allocationSpaces,
        valueSpacesDict: allocationSpaceNames
    };

    lineTrees.push(createLineTree(
        'call-stack',
        line,
        { dict, tree },
        { samplesMetrics, samplesMetricsFiltered, recomputeMetrics }
    ));

    if (allocationLocationMetrics !== null) {
        lineTrees.push(createLineTree(
            'locations',
            line,
            {
                dict: allocationLocationMetrics.dict,
                tree: allocationLocationMetrics.tree
            },
            {
                samplesMetrics: allocationLocationMetrics.samplesMetrics,
                samplesMetricsFiltered: allocationLocationMetrics.samplesMetricsFiltered,
                recomputeMetrics: allocationLocationMetrics.recomputeMetrics
            }
        ));
    }

    return line;
}
