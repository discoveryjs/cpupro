import type { Model } from '@discoveryjs/discovery';
import { convertToInt32Array, convertToUint32Array } from './misc/utils.js';
import { fixTimeDeltasOrderIfNeeded, processLongTimeDeltas, createTimelineAxis } from './preprocessing/time-deltas.js';
import { processMemoryAllocations } from './preprocessing/memory-allocations.mjs';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { createTimeline, createMemline } from './lines/index.mjs';
import { extractCallFramesFromNodes } from './preprocessing/call-frames.js';
import { GeneratedNodes, processNodes } from './preprocessing/nodes.js';
import { processCallFrameCodes } from './preprocessing/call-frame-codes.js';
import { processLocations } from './preprocessing/locations.js';
import { detectRuntime } from './misc/detect-runtime.js';
import { buildTrees } from './computations/build-trees.js';
import { ProfileScriptsMap } from './preprocessing/scripts.js';
import { Dictionary } from './dictionary.js';
import { Usage } from './usage.js';
import { CpuProCallFrame, CpuProThread, V8CpuProfile } from './types.js';
// import { computeCrossProfileUsage } from './computations/cross-profile-usage.mjs';
import { setSamplesConvolutionRule } from './computations/samples-convolution.mjs';
import { createLineMapping } from './computations/line-mapping.js';
import { ProfileLine } from './lines/types.js';
import { createLineBoundaries } from './misc/line-boundaries.js';
import { SampleConvolutionRule } from './computations/call-tree.js';
import { remapTreeSamples } from './preprocessing/samples.js';

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

    // computeCrossProfileUsage(enabledProfiles, callFramesProfilePresence);
    setSamplesConvolutionRule(enabledProfiles, callFramesProfilePresence, currentSamplesConvolutionRule);

    return true;
}

// FIXME: quick & dirty implementation
function scriptOffsetsFromLineColumns(
    nodes: V8CpuProfile['nodes'],
    samples: V8CpuProfile['samples'],
    callFrames: V8CpuProfile['_callFrames'],
    scripts?: V8CpuProfile['_scripts'],
    lines?: V8CpuProfile['lines'],
    columns?: V8CpuProfile['columns']
): number[] | null {
    if (!Array.isArray(scripts)) {
        return null;
    }

    if (!Array.isArray(lines) || !Array.isArray(columns) || lines.length !== columns.length || lines.length === 0) {
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
    const lines: ProfileLine[] = [];
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;
    const generatedNodes = new GeneratedNodes(dictionary, data.nodes.length + 1);

    // Extract script offset first, since they depends on timestamps order,
    // and should be moved together with timeDeltas if the order is adjusted
    const _dataScriptOffsets = data._samplePositions || await work('extract sample script offsets', () =>
        scriptOffsetsFromLineColumns(
            data.nodes,
            data.samples,
            data._callFrames,
            data._scripts,
            data.lines,
            data.columns
        )
    );

    //
    // Process profile samples & time stamps
    //

    // preprocess timeDeltas, fix order if necessary
    // FIXME: mutate samples/timeDeltas
    await work('fix time deltas order', () =>
        fixTimeDeltasOrderIfNeeded(
            data.timeDeltas,
            data.samples,
            _dataScriptOffsets
        )
    );

    // create samples axis
    const axis = profileType === 'time'
        ? await work('process time deltas', () =>
            createTimelineAxis(
                data.startTime,
                data.endTime,
                data.timeDeltas,
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
                axis.samplesInterval,
                data.timeDeltas,
                data.samples,
                _dataScriptOffsets,
                generatedNodes
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
        sampleLocations: Array.isArray(_dataScriptOffsets)
            ? convertToInt32Array(_dataScriptOffsets)
            : null
    }));

    // attach root GC node samples to previous call stack;
    // this operation produces new nodes
    await work('reparent GC samples', () =>
        reparentGcNodes(
            data.nodes,
            generatedNodes,
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
        extractCallFramesFromNodes(
            dictionary,
            data.nodes,
            data._callFrames,
            profileScriptsMap,
            generatedNodes
        )
    );

    //
    // Create profile's data derivatives
    //

    const { nodeIndexById, nodeParent, nodeLocations } = await work('process nodes', () =>
        processNodes(
            data.nodes,
            generatedNodes,
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
            nodeLocations,
            dictionary.callFrames,
            callFrameByNodeIndex,
            samples,
            sampleLocations
        )
    );

    //
    // Usage vectors
    //

    const usage = await work('usage', () =>
        new Usage(dictionary, callFrameByNodeIndex, generatedNodes)
    );

    //
    // Create profile's data derivatives
    //

    const {
        sourceIdToNode,
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

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    const sampledTreeList = await work('remap samples', () =>
        remapTreeSamples(
            samples,
            sourceIdToNode,
            [
                ...(locationsTree ? [locationsTree] : []),
                callFramesTree,
                modulesTree,
                packagesTree,
                categoriesTree
            ]
        )
    );

    // Create timeline (CPU time profiling line)
    const timeline = await createTimeline(
        data,
        axis,
        samples,
        timeDeltas,
        sampledTreeList,
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
        samples,
        sampledTreeList,
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
            axis.start,
            axis.end
        )
    );

    // create profile
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

    for (const line of lines) {
        line.profile = profile;
    }

    return profile;
}
