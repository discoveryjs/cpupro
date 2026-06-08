import type { Model } from '@discoveryjs/discovery';
import { convertToInt32Array, convertToUint32Array } from './misc/utils.js';
import { processLongTimeDeltas, processTimeDeltas } from './preprocessing/time-deltas.js';
import { processMemoryAllocations } from './preprocessing/memory-allocations.mjs';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { createTimeline, createMemline } from './lines/index.mjs';
import { extractCallFrames } from './preprocessing/call-frames.js';
import { processNodes } from './preprocessing/nodes.js';
import { processCallFrameCodes } from './preprocessing/call-frame-codes.js';
import { processLocations } from './preprocessing/locations.js';
import { detectRuntime } from './misc/detect-runtime.js';
import { buildTrees } from './computations/build-trees.js';
import { ProfileScriptsMap } from './preprocessing/scripts.js';
import { Dictionary } from './dictionary.js';
import { Usage } from './usage.js';
import { CpuProCallFrame, CpuProThread, GeneratedNodes, V8CpuProfile } from './types.js';
import { computeCrossProfileUsage } from './computations/cross-profile-usage.mjs';
import { setSamplesConvolutionRule } from './computations/samples-convolution.mjs';
import { createLineMapping } from './computations/line-mapping.js';
import { ProfileLine } from './lines/types.js';
import { createLineBoundaries } from './misc/line-boundaries.js';
import { SampleConvolutionRule } from './computations/call-tree.js';

const experimentalFeatures = false;

export type Profile = Awaited<ReturnType<typeof createProfile>>;
export type CreateProfileApi = {
    work<T>(name: string, fn: () => T): Promise<T>;
}

type BucketProfileEntry = {
    profile: Profile;
    disabled: boolean;
};
export function toggleProfile(model: Model, profile: Profile) {
    const {
        currentSamplesConvolutionRule,
        primaryProfile,
        profiles
    } = model.context as {
        currentSamplesConvolutionRule: SampleConvolutionRule<CpuProCallFrame> | null;
        primaryProfile: Profile | null;
        profiles: BucketProfileEntry[];
    };
    const {
        callFramesProfilePresence
    } = model.data;
    const bucketProfileEntry = profiles.find(entry => entry.profile === profile);

    if (!bucketProfileEntry) {
        return false;
    }

    const disable = !bucketProfileEntry.disabled;
    const enabledProfiles = profiles.filter(entry => entry === bucketProfileEntry
        ? entry.disabled // for the profile to toggle, the disabled property will be inverted
        : !entry.disabled
    ).map(entry => entry.profile);

    if (disable && enabledProfiles.length < 2) {
        return false;
    }

    const newPrimaryProfile = disable && bucketProfileEntry.profile === primaryProfile
        ? enabledProfiles[0] || null
        : primaryProfile;

    model.setContext({
        primaryProfile: newPrimaryProfile,
        profiles: profiles.map(entry => ({
            ...entry,
            disabled: entry === bucketProfileEntry ? disable : entry.disabled
        }))
    });

    computeCrossProfileUsage(enabledProfiles, callFramesProfilePresence);
    setSamplesConvolutionRule(enabledProfiles, callFramesProfilePresence, currentSamplesConvolutionRule);

    return true;
}

// FIXME: quick & dirty implementation
function positionsFromScriptsLineColumns(
    nodes: V8CpuProfile['nodes'],
    callFrames: V8CpuProfile['_callFrames'],
    scripts: V8CpuProfile['_scripts'],
    samples: V8CpuProfile['samples'],
    lines?: V8CpuProfile['lines'],
    columns?: V8CpuProfile['columns']
): number[] | null {
    if (!Array.isArray(lines) || !Array.isArray(columns) || lines.length !== columns.length || lines.length === 0) {
        return null;
    }

    if (!scripts) {
        return null;
    }

    const scriptLineBoundaries = Object.create(null) as Record<number, ReturnType<typeof createLineBoundaries>>;
    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script && script.source) {
            scriptLineBoundaries[script.id] = createLineBoundaries(script.source);
        }
    }

    const nodeById = Object.create(null) as Record<number, V8CpuProfile['nodes'][0]>;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        nodeById[node.id] = node;
    }

    const result = new Array<number>(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const callFrameRaw = nodeById[samples[i]].callFrame;
        const callFrame = typeof callFrameRaw === 'number' ? callFrames![callFrameRaw] : callFrameRaw;
        const scriptId = Number(callFrame.scriptId);
        const scriptEntry = scriptLineBoundaries[scriptId];
        let offset = -1;

        if (scriptEntry && lines[i]) {
            offset = scriptEntry.getOffset(lines[i], columns[i]);
        }

        result[i] = offset;
    }

    return result;
}

export async function createProfile(
    data: V8CpuProfile,
    dictionary: Dictionary,
    { work }: CreateProfileApi
) {
    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    const lines: ProfileLine[] = [];
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;
    const generateNodes: GeneratedNodes = {
        dict: dictionary,
        nodeIdSeed: data.nodes.length + 1,
        noSamplesNodeId: -1,
        callFrames: [],
        nodeParentId: [],
        parentScriptOffsets: [],
        get count() {
            return this.nodeParentId.length;
        }
    };

    const _dataPositions = data._samplePositions ||
        positionsFromScriptsLineColumns(
            data.nodes,
            data._callFrames,
            data._scripts,
            data.samples,
            data.lines,
            data.columns
        );

    //
    // Process profile samples & time stamps
    //

    // preprocess timeDeltas, fix order if necessary
    // FIXME: mutate samples/timeDeltas
    const {
        startTime,
        startNoSamplesTime,
        endTime,
        endNoSamplesTime,
        totalTime,
        samplesInterval
    } = profileType === 'time'
        ? await work('process time deltas', () =>
            processTimeDeltas(
                data.startTime,
                data.endTime,
                data.timeDeltas,
                data.samples,
                _dataPositions || undefined,
                data._samplesInterval // could be computed on V8 log convertation into cpuprofile
            )
        )
        : await work('process memory allocations', () =>
            processMemoryAllocations(
                data.timeDeltas,
                data._samplesInterval // could be computed on profile's preprocessing
            )
        );

    // normalize long samples (time deltas)
    if (experimentalFeatures && profileType === 'time') {
        await work('process time deltas', () =>
            processLongTimeDeltas(
                samplesInterval,
                data.timeDeltas,
                data.samples,
                _dataPositions || undefined,
                generateNodes
            )
        );
    }

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    const {
        samples,
        timeDeltas,
        sampleLocations
    } = await work('convert samples & timeDeltas into TypedArrays', () => ({
        samples: convertToUint32Array(data.samples),
        timeDeltas: convertToUint32Array(data.timeDeltas),
        sampleLocations: Array.isArray(_dataPositions)
            ? convertToInt32Array(_dataPositions)
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

    //
    // Consume dictionaries
    //

    const profileScriptsMap = new ProfileScriptsMap(dictionary, data._scripts);

    const {
        callFrameByIndex,
        callFrameByNodeIndex
    } = await work('extract call frames', () =>
        extractCallFrames(
            dictionary,
            data.nodes,
            data._callFrames,
            profileScriptsMap,
            generateNodes
        )
    );

    // process function codes
    const {
        codes,
        codesByCallFrame,
        codesByScript
    } = await work('process function codes', () =>
        processCallFrameCodes(
            data._callFrameCodes,
            callFrameByIndex,
            dictionary.callFrames,
            startTime,
            endTime
        )
    );

    //
    // Usage vectors
    //

    const usage = await work('usage', () =>
        new Usage(dictionary, callFrameByNodeIndex)
    );

    //
    // Create profile's data derivatives
    //

    const { nodeIndexById, nodeParent, nodePositions } = await work('process nodes', () =>
        processNodes(
            data.nodes,
            generateNodes,
            callFrameByNodeIndex,
            dictionary
        )
    );

    // call frame positions
    const { locationsTreeSource } = await work('process locations', () =>
        processLocations(
            dictionary,
            nodeIndexById,
            nodeParent,
            nodePositions,
            dictionary.callFrames,
            callFrameByNodeIndex,
            samples,
            sampleLocations
        )
    );

    //
    // Create profile's data derivatives
    //

    const {
        treeSource,
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = await work('build trees', () =>
        buildTrees(
            dictionary,
            nodeParent,
            nodeIndexById,
            callFrameByNodeIndex,
            locationsTreeSource,
            usage
        )
    );

    // Create timeline (CPU time profiling line)
    const timeline = await createTimeline(
        // Source metadata
        { nodes: nodesCount, samples: samplesCount, samplesInterval },
        // Axis info
        { start: startTime, startNoSamples: startNoSamplesTime, end: endTime, endNoSamples: endNoSamplesTime, total: totalTime },
        // Samples data
        { samples, sampleLocations, values: timeDeltas },
        // Trees
        { locationsTreeSource, treeSource, locationsTree, callFramesTree, modulesTree, packagesTree, categoriesTree },
        { work }
    );
    if (timeline) {
        lines.push(timeline);
    }

    // Create memline from allocation data if present (combined profile)
    const memline = await createMemline(
        data,
        dictionary,
        profileScriptsMap,
        timeline ? timeline.samplesMetrics.samples : convertToUint32Array(data.samples),
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        timeline?.trees[0] || null,
        { work }
    );

    if (memline) {
        lines.push(memline);
    }

    // Create mappings between lines if both exist
    if (memline && timeline && memline.mappings && timeline.mappings) {
        memline.mappings.timeline = createLineMapping(
            memline.samplesMetrics,
            timeline.samplesMetrics
        );
        timeline.mappings.memline = createLineMapping(
            timeline.samplesMetrics,
            memline.samplesMetrics
        );

        if (data._cpuproAllocationMapping && data._cpuproAllocationIds) {
            timeline.mappings.memline._mapping.set(data._cpuproAllocationMapping);

            const mapping = timeline.mappings.memline._mapping;
            const memlineSamples = data._cpuproAllocationIds!; // [0, 1, 2, 3, 4, ...]
            const memlineToTimelineMap = memline.mappings.timeline._mapping;
            // [0, 0, 1, 1, 1, 3, 3, ...] -> timeline sample ids
            // we attach memline sample id to the cpu sample id it was recorded after

            const lastCpuSampleIndex = mapping.length - 1;
            for (let i = 0, k = 0; i < memlineSamples.length; i++) {
                const allocId = memlineSamples[i];
                let cpuSampleLastSeen = mapping[k];

                while (k < lastCpuSampleIndex && allocId > cpuSampleLastSeen) {
                    cpuSampleLastSeen = mapping[++k];
                }

                memlineToTimelineMap[i] = k;
            }
        }
    }

    const profileLocationsTree = timeline?.tree.locations?.all.tree || locationsTree;
    const profileCallFramesTree = timeline?.tree.callFrames?.all.tree || callFramesTree;
    const profileModulesTree = timeline?.tree.modules?.all.tree || modulesTree;
    const profilePackagesTree = timeline?.tree.packages?.all.tree || packagesTree;
    const profileCategoriesTree = timeline?.tree.categories?.all.tree || categoriesTree;

    const profile = {
        name: data._name,
        runtime: detectRuntime(usage.categories, usage.packages, data._runtime), // FIXME: categories/packages must be related to profile
        thread: null as unknown as CpuProThread, // to be set by caller

        ...usage,
        codes,
        codesByCallFrame,
        codesByScript,

        locationsTree: profileLocationsTree,
        callFramesTree: profileCallFramesTree,
        modulesTree: profileModulesTree,
        packagesTree: profilePackagesTree,
        categoriesTree: profileCategoriesTree,

        // lines
        timeline,
        memline,
        lines,

        // ---- legacy fields ----

        heap: data._heap || null
    };

    for (const line of [timeline, memline]) {
        if (line) {
            line.profile = profile;
        }
    }

    return profile;
}
