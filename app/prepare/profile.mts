import type { Model } from '@discoveryjs/discovery';
import { convertToInt32Array, convertToUint32Array } from './misc/utils.js';
import { fixTimeDeltasOrderIfNeeded, processLongTimeDeltas, createTimelineAxis, enumerateLongTimeDeltas, LongTimeDeltas } from './preprocessing/time-deltas.js';
import { processMemoryAllocations } from './preprocessing/memory-allocations.mjs';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { createTimeline, createMemline } from './lines/index.mjs';
import { extractCallFramesFromNodes } from './preprocessing/call-frames.js';
import { createNodeIndexById, createNodeLocations, createNodeParent, GeneratedNodes } from './preprocessing/nodes.js';
import { processCallFrameCodes } from './preprocessing/call-frame-codes.js';
import { processLocations } from './preprocessing/locations.js';
import { detectRuntime } from './misc/detect-runtime.js';
import { createTreeSet } from './computations/build-trees.js';
import { ProfileScriptsMap } from './preprocessing/scripts.js';
import { Dictionary } from './dictionary.js';
import { Usage } from './usage.js';
import { CpuProThread, V8CpuProfile } from './types.js';
import { createLineMapping } from './computations/line-mapping.js';
import { ProfileLine } from './lines/types.js';
import { createLineBoundaries } from './misc/line-boundaries.js';
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

    const scriptLineBoundaries = Object.create(null) as Record<number, {
        lineBoundaries: ReturnType<typeof createLineBoundaries>;
        lineOffset: number;
        columnOffset: number;
    }>;
    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script && script.source) {
            scriptLineBoundaries[script.id] = {
                lineBoundaries: createLineBoundaries(script.source),
                lineOffset: script.lineOffset ?? 0,
                columnOffset: script.columnOffset ?? 0
            };
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
        const line = lines[i];
        let offset = -1;

        if (scriptEntry && line) {
            const column = columns[i];
            offset = scriptEntry.lineBoundaries.getOffset(
                line - scriptEntry.lineOffset,
                column - (line === scriptEntry.lineOffset ? scriptEntry.columnOffset : 0)
            );
        }

        result[i] = offset;
    }

    return result;
}

async function createTree_(
    dictionary: Dictionary,
    nodeIndexById: Int32Array,
    nodeParent: Uint32Array,
    nodeScriptOffsets: Int32Array,
    callFrameByNodeIndex: Uint32Array,
    samples: Uint32Array,
    sampleScriptOffsets: Int32Array | null,
    generatedNodes: GeneratedNodes,
    { work }: CreateProfileApi
) {
    // call frame positions
    const { locationsTreeSource } = await work('process locations', () =>
        processLocations(
            dictionary,
            nodeParent,
            nodeScriptOffsets,
            dictionary.callFrames,
            callFrameByNodeIndex,
            samples,
            sampleScriptOffsets
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
        categoriesTree,
        ownersTree
    } = await work('build trees', () =>
        createTreeSet(
            dictionary,
            nodeParent,
            nodeIndexById,
            callFrameByNodeIndex,
            locationsTreeSource,
            usage
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

    return {
        sampledTreeSet,
        usage // FIXME: temporary, remove after usage is moved
    };
}

export async function createProfile(
    data: V8CpuProfile,
    dictionary: Dictionary,
    { work }: CreateProfileApi
) {
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

    const nodeScriptOffsets = await work('create node locations', () =>
        createNodeLocations(
            data.nodes,
            nodeParent,
            generatedNodes,
            callFrameByNodeIndex,
            dictionary
        )
    );

    const { sampledTreeSet, usage } = await work('create tree breakdown', () =>
        createTree_(
            dictionary,
            nodeIndexById,
            nodeParent,
            nodeScriptOffsets,
            callFrameByNodeIndex,
            samples,
            sampleScriptOffsets,
            generatedNodes,
            { work }
        )
    );

    // Create timeline (CPU time profiling line)
    const timeline = await createTimeline(
        data,
        axis,
        samples,
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
        samples,
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
        name: data._name,
        runtime: detectRuntime(usage.categories, usage.packages, data._runtime), // FIXME: categories/packages must be related to profile
        thread: null as unknown as CpuProThread, // to be set by caller

        ...usage,
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
