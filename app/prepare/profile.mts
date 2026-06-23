import type { Model } from '@discoveryjs/discovery';
import type { CpuProCallFrame, CpuProLocation, CpuProThread, RuntimeCode, V8CpuProfile } from './types.js';
import type { ProfileLine } from './lines/types.js';
import type { Ownership } from './formats/types.js';
import { convertToInt32Array, convertToUint32Array } from './misc/utils.js';
import { fixTimeDeltasOrderIfNeeded, processLongTimeDeltas, createTimelineAxis, enumerateLongTimeDeltas, LongTimeDeltas } from './preprocessing/time-deltas.js';
import { processMemoryAllocations } from './preprocessing/memory-allocations.mjs';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { createTimeline, createMemline } from './lines/index.mjs';
import { extractCallFramesFromNodes } from './preprocessing/call-frames.js';
import { createNodeIndexById, createNodeScriptOffsets, createNodeParent, GeneratedNodes } from './preprocessing/nodes.js';
import { processCallFrameCodes } from './preprocessing/call-frame-codes.js';
import { createLocationsFromScriptOffsets } from './preprocessing/locations.js';
import { detectRuntime } from './misc/detect-runtime.js';
import { createTreeSet, createTreeSourceFromParent, TreeSource } from './computations/build-trees.js';
import { ProfileScriptsMap, scriptOffsetsFromLineColumns } from './preprocessing/scripts.js';
import { Dictionary } from './dictionary.js';
import { Usage } from './usage.js';
import { createLineMapping } from './computations/line-mapping.js';
import { remapTreeSamples } from './preprocessing/samples.js';
import { processSourceMaps } from './profile-sm.mjs';
import { noopWorkHandler, WorkHandler } from './misc/work.js';

const experimentalFeatures = false;

export type Profile = Awaited<ReturnType<typeof createProfile>>;
export type CreateProfileOptions = {
    dictionary: Dictionary;
    ownership: Ownership | null;
    runtime: RuntimeCode | null;
    work: WorkHandler;
};
export type CreateProfileApi = {
    work<T>(name: string, fn: () => T): Promise<T>;
}

type BucketProfileEntry = {
    profile: Profile;
    disabled: boolean;
};
export function toggleProfile(model: Model, profile: Profile) {
    const {
        primaryProfile,
        profiles
    } = model.context as {
        primaryProfile: Profile | null;
        profiles: BucketProfileEntry[];
    };
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

    return true;
}

export async function createSampledTreeSet(
    dictionary: Dictionary,
    treeSource: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>,
    samples: Uint32Array,
    work: WorkHandler
) {
    // call frame positions

    const treeSetSource = createTreeSourceFromParent(
        treeSource.parent,
        treeSource.sourceIdToNode,
        treeSource.nodes,
        treeSource.dictionary
    );

    //
    // Usage vectors
    //

    // const usage = await work('usage', () =>
    //     new Usage(dictionary, nodeCallFrames, generatedNodes)
    // );

    //
    // Create profile's data derivatives
    //

    const {
        sourceIdToNode,
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        ownersTree
    } = await work('build trees', () =>
        createTreeSet(
            dictionary,
            treeSetSource
            // usage
        )
    );

    // re-map samples
    // FIXME: remap callFramesTree only, before createTreeSet()?
    const sampledTreeSet = await work('remap samples', () =>
        remapTreeSamples(
            samples,
            sourceIdToNode,
            [
                ...(locationsTree ? [locationsTree] : []),
                callFramesTree,
                modulesTree,
                packagesTree,
                categoriesTree,
                ownersTree
            ]
        )
    );

    return sampledTreeSet;
}

export async function createProfile(data: V8CpuProfile, options?: Partial<CreateProfileOptions>) {
    const {
        dictionary = new Dictionary(),
        runtime = null,
        ownership = null,
        work = noopWorkHandler
    } = options || {};
    const lines: ProfileLine[] = [];
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;
    const generatedNodes = new GeneratedNodes(dictionary, data.nodes.length);

    // Extract script offset first, since they depends on timestamps order,
    // and should be moved together with timeDeltas if the order is adjusted in fixTimeDeltasOrderIfNeeded()
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
    // FIXME: avoid mutation of samples/timeDeltas/scriptOffsets
    await work('ensure correct time deltas order', () =>
        fixTimeDeltasOrderIfNeeded(
            data.timeDeltas,
            data.samples,
            _dataScriptOffsets
        )
    );

    // create samples axis
    const axis = profileType === 'time'
        ? await work('process time deltas', () =>
            // FIXME: avoid mutation of timeDeltas
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
    // FIXME: avoid mutation of samples/timeDeltas/scriptOffsets
    let longDeltas: LongTimeDeltas | null = null;
    if (experimentalFeatures && profileType === 'time') {
        longDeltas = await work('enumerate long time deltas', () =>
            enumerateLongTimeDeltas(
                axis.samplesInterval,
                data.timeDeltas
            )
        );
    }

    // convert arrays into TypedArrays;
    // after this point these arrays will not change their length
    const extraLength = longDeltas?.longTimeDeltasCount ?? 0;
    const {
        timeDeltas,
        samples,
        sampleScriptOffsets
    } = await work('convert vectors into TypedArrays', () => ({
        timeDeltas: convertToUint32Array(data.timeDeltas, extraLength),
        samples: convertToUint32Array(data.samples, extraLength),
        sampleScriptOffsets: Array.isArray(_dataScriptOffsets)
            ? convertToInt32Array(_dataScriptOffsets, extraLength)
            : null
    }));

    // create node index by id and remap sample node ids to node indices;
    // at this point, only data.nodes use ids for reference to other nodes
    const nodeIndexById = await work('remap samples to node indices', () => {
        const nodeIndexById = createNodeIndexById(data.nodes);

        for (let i = 0; i < samples.length; i++) {
            samples[i] = nodeIndexById[samples[i]];
        }

        return nodeIndexById;
    });

    // process long time deltas if needed
    if (longDeltas !== null) {
        await work('process long time deltas', () =>
            processLongTimeDeltas(
                longDeltas,
                timeDeltas,
                samples,
                sampleScriptOffsets,
                generatedNodes
            )
        );
    }

    // attach root GC node samples to previous call stack;
    // this operation produces new nodes
    await work('reparent GC samples', () =>
        reparentGcNodes(
            data.nodes,
            generatedNodes,
            data._callFrames || null,
            samples,
            sampleScriptOffsets
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

    const nodeParent = await work('process nodes', () =>
        createNodeParent(
            data.nodes,
            nodeIndexById,
            generatedNodes
        )
    );

    const nodeScriptOffsets = await work('create node script offsets', () =>
        createNodeScriptOffsets(
            data.nodes,
            nodeParent,
            generatedNodes,
            callFrameByNodeIndex,
            dictionary
        )
    );

    const callStackBreakdownBasis = await work('create tree source', () =>
        createLocationsFromScriptOffsets(
            dictionary,
            nodeParent,
            nodeScriptOffsets,
            callFrameByNodeIndex,
            samples,
            sampleScriptOffsets
        ) || {
            parent: nodeParent,
            sourceIdToNode: Int32Array.from({ length: nodeParent.length }, (_, i) => i),
            nodes: callFrameByNodeIndex,
            dictionary: dictionary.callFrames as CpuProCallFrame[]
        }
    );

    const usage = new Usage(dictionary, callFrameByNodeIndex, generatedNodes);
    const sampledTreeSet = await work('create tree breakdown', () =>
        createSampledTreeSet(
            dictionary,
            callStackBreakdownBasis,
            samples,
            work
        )
    );

    // Create timeline (CPU time profiling line)
    const timeline = await createTimeline(
        data,
        axis,
        timeDeltas,
        sampledTreeSet,
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
        sampledTreeSet,
        { work }
    );

    if (memline) {
        lines.push(memline);
    }

    // Create mappings between lines if both exist
    if (memline && timeline && memline.mappings && timeline.mappings) {
        const memlineCallStackTree = memline.trees.find(tree => tree.kind === 'call-stack')!;
        const timelineCallStackTree = timeline.trees.find(tree => tree.kind === 'call-stack')!;

        const memlineToTimeline = createLineMapping(
            memlineCallStackTree.samplesMetrics,
            timelineCallStackTree.samplesMetrics
        );
        const timelineToMemline = createLineMapping(
            timelineCallStackTree.samplesMetrics,
            memlineCallStackTree.samplesMetrics
        );

        memline.mappings.timeline = memlineToTimeline;
        timeline.mappings.memline = timelineToMemline;

        if (data._cpuproAllocationMapping && data._cpuproAllocationIds) {
            timelineToMemline._mapping.set(data._cpuproAllocationMapping);

            const mapping = timelineToMemline._mapping;
            const memlineSamples = data._cpuproAllocationIds; // [0, 1, 2, 3, 4, ...]
            const memlineToTimelineMap = memlineToTimeline._mapping;
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
        name: data._name ?? null,
        runtime: detectRuntime(usage.categories, usage.packages, runtime || data._runtime), // FIXME: categories/packages must be related to profile
        thread: null as unknown as CpuProThread, // to be set by caller

        // ...usage,
        ...dictionary,
        codes,
        codesByCallFrame,
        codesByScript,

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
