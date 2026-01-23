import type { Model } from '@discoveryjs/discovery';
import { convertToInt32Array, convertToUint32Array } from './misc/utils.js';
import { mergeSamples } from './preprocessing/samples.js';
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
import { GeneratedNodes, V8CpuProfile } from './types.js';
import { computeCrossProfileUsage } from './computations/cross-profile-usage.mjs';
import { setSamplesConvolutionRule } from './computations/samples-convolution.mjs';
import { createLineMapping } from './computations/line-mapping.js';
import { MERGE_SAMPLES } from './const.js';
import { ProfileLine } from './lines/types.js';
import { createLineBoundaries } from './misc/line-boundaries.js';

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
    } = model.context;
    const {
        callFramesProfilePresence
    } = model.data;
    const bucketProfileEntry = profiles.find((entry: BucketProfileEntry) => entry.profile === profile);

    if (!bucketProfileEntry) {
        return false;
    }

    const disable = !bucketProfileEntry.disabled;
    const enabledProfiles = profiles.filter((entry: BucketProfileEntry) => entry === bucketProfileEntry
        ? entry.disabled // for the profile to toggle, the disabled property will be inverted
        : !entry.disabled
    ).map(({ profile }) => profile);

    if (disable && enabledProfiles.length < 2) {
        return false;
    }

    const newPrimaryProfile = disable && bucketProfileEntry.profile === primaryProfile
        ? enabledProfiles[0] || null
        : primaryProfile;

    model.data = {
        ...model.data,
        totalTime: enabledProfiles.reduce((max, profile) => Math.max(profile.totalTime, max), 0),
        primaryProfile: newPrimaryProfile,
        currentProfile: newPrimaryProfile
    };
    model.setContext({
        primaryProfile: newPrimaryProfile,
        profiles: profiles.map((entry: BucketProfileEntry) => ({
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
            scriptLineBoundaries[script.id].script = script;
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

export async function createProfile(data: V8CpuProfile, dictionary: Dictionary, { work }: CreateProfileApi) {
    // TODO Phase 5: Support multiple sources
    // Future signature: createProfile(sources: { time?, memory?, gc? }, dict, api)
    // For now, treat single source as primary line

    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    const lines: ProfileLine[] = [];
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;
    const skipSampleMerge = profileType === 'memory' || !MERGE_SAMPLES;
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

    const _dataPositions = data._positions ||
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
                _dataPositions,
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
                _dataPositions,
                generateNodes
            )
        );
    }

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    const {
        rawSamples,
        rawTimeDeltas,
        rawSampleLocations
    } = await work('convert samples & timeDeltas into TypedArrays', () => ({
        rawSamples: convertToUint32Array(data.samples),
        rawTimeDeltas: convertToUint32Array(data.timeDeltas),
        rawSampleLocations: Array.isArray(_dataPositions)
            ? convertToInt32Array(_dataPositions)
            : null
    }));

    // process samples
    const {
        samples,
        sampleCounts,
        sampleLocations,
        timeDeltas
    } = await work('process samples', () =>
        !skipSampleMerge
            ? mergeSamples(rawSamples, rawTimeDeltas, rawSampleLocations)
            : {
                samples: rawSamples,
                sampleCounts: new Uint32Array(rawSamples.length).fill(1),
                sampleLocations: rawSampleLocations,
                timeDeltas: rawTimeDeltas
            }
    );

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

    const {
        callFrameByIndex,
        callFrameByNodeIndex
    } = await work('extract call frames', () =>
        extractCallFrames(
            dictionary,
            data.nodes,
            data._callFrames,
            new ProfileScriptsMap(dictionary, data._scripts),
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
        processNodes(data.nodes, generateNodes)
    );

    // call frame positions
    const { locationsTreeSource } = await work('process locations', () =>
        processLocations(
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
        { samples, sampleCounts, sampleLocations, values: timeDeltas },
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
        timeline ? timeline.samplesMetrics.samples : data.samples,
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,
        { work }
    );

    if (memline) {
        lines.push(memline);
    }

    const primaryLine = memline || timeline;

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

    type Timeline = typeof timeline;
    const getters = transitionTimelineGetters<Timeline>({}, timeline!);

    const profile = {
        name: data._name,
        disabled: false,
        runtime: detectRuntime(usage.categories, usage.packages, data._runtime), // FIXME: categories/packages must be related to profile

        ...usage,
        codes,
        codesByCallFrame,
        codesByScript,

        locationsTreeSource, // FIXME: do we need to expose source?
        locationsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree,

        // lines
        timeline,
        memline,
        gcline: null as ProfileLine | null,
        lines,

        // primaryLine reference (currently selected line in UI)
        defaultLineType: primaryLine?.type || null,

        traceEvents: data._cpuproTraceEvents || [],

        // ---- legacy fields ----

        heap: data._heap || null,

        ...getters
    };

    transitionTimelineGetters(profile, timeline);

    for (const line of [timeline, memline]) {
        if (line) {
            line.profile = profile;
        }
    }

    return profile;
}

// define timeline getters/setters for legacy fields
// during transition period
function transitionTimelineGetters<T>(result: unknown, timeline: T) {
    const timelineTransitionGetters = {
        sourceInfo: true,
        type: 'kind',

        startTime: 'axisStart',
        startNoSamplesTime: 'axisStartNoSamples',
        endTime: 'axisEnd',
        endNoSamplesTime: 'axisEndNoSamples',
        totalTime: 'axisTotal',

        samples: true,
        sampleCounts: true,
        sampleCountsByProfile: true,
        samplePositions: true,

        timeDeltas: 'values',
        timeDeltasByProfile: 'valuesByProfile',
        samplesTimings: 'samplesMetrics',
        samplesTimingsFiltered: 'samplesMetricsFiltered',
        recomputeTimings: 'recomputeValues',

        callFramePositionsTimings: 'dict.locations.all',
        callFramePositionsTimingsFiltered: 'dict.locations.filtered',
        callFramePositionsTreeTimings: 'tree.locations.all',
        callFramePositionsTreeTimingsFiltered: 'tree.locations.filtered',
        callFramePositionsTreeTimestamps: 'tree.locations.bounds',

        callFramesTimings: 'dict.callFrames.all',
        callFramesTimingsFiltered: 'dict.callFrames.filtered',
        callFramesTreeTimings: 'tree.callFrames.all',
        callFramesTreeTimingsFiltered: 'tree.callFrames.filtered',
        callFramesTreeTimestamps: 'tree.callFrames.bounds',

        modulesTimings: 'dict.modules.all',
        modulesTimingsFiltered: 'dict.modules.filtered',
        modulesTreeTimings: 'tree.modules.all',
        modulesTreeTimingsFiltered: 'tree.modules.filtered',
        modulesTreeTimestamps: 'tree.modules.bounds',

        packagesTimings: 'dict.packages.all',
        packagesTimingsFiltered: 'dict.packages.filtered',
        packagesTreeTimings: 'tree.packages.all',
        packagesTreeTimingsFiltered: 'tree.packages.filtered',
        packagesTreeTimestamps: 'tree.packages.bounds',

        categoriesTimings: 'dict.categories.all',
        categoriesTimingsFiltered: 'dict.categories.filtered',
        categoriesTreeTimings: 'tree.categories.all',
        categoriesTreeTimingsFiltered: 'tree.categories.filtered',
        categoriesTreeTimestamps: 'tree.categories.bounds'
    };

    for (const [key, value] of Object.entries(timelineTransitionGetters)) {
        let target = timeline;
        let targetKey: string = key;

        if (typeof value === 'string') {
            const path = value.split('.');
            targetKey = path.pop()!;

            for (let i = 0; i < path.length; i++) {
                target = target![path[i]];
            }
        }

        Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            get() {
                // TODO: warn about legacy field usage
                return target ? target[targetKey] : null;
            },
            set(newValue) {
                if (!target) {
                    throw new Error('Cannot set value on undefined target');
                }

                target[targetKey] = newValue;
            }
        });
    }

    return result as {
        // @ts-expect-error migration
        sourceInfo: T['sourceInfo'], // @ts-expect-error migration

        startTime: T['axisStart'], // @ts-expect-error migration
        startNoSamplesTime: T['axisStartNoSamples'], // @ts-expect-error migration
        endTime: T['axisEnd'], // @ts-expect-error migration
        endNoSamplesTime: T['axisEndNoSamples'], // @ts-expect-error migration
        totalTime: T['axisTotal'], // @ts-expect-error migration

        samples: T['samples'], // @ts-expect-error migration
        sampleCounts: T['sampleCounts'], // @ts-expect-error migration
        sampleCountsByProfile: T['sampleCountsByProfile'], // @ts-expect-error migration
        samplePositions: T['samplePositions'], // @ts-expect-error migration

        timeDeltas: T['values'], // @ts-expect-error migration
        timeDeltasByProfile: T['valuesByProfile'], // @ts-expect-error migration
        samplesTimings: T['samplesMetrics'], // @ts-expect-error migration
        samplesTimingsFiltered: T['samplesMetricsFiltered'], // @ts-expect-error migration
        recomputeTimings: T['recomputeValues'], // @ts-expect-error migration

        callFramePositionsTimings: T['dict']['locations']['all'], // @ts-expect-error migration
        callFramePositionsTimingsFiltered: T['dict']['locations']['filtered'], // @ts-expect-error migration
        callFramePositionsTreeTimings: T['tree']['locations']['all'], // @ts-expect-error migration
        callFramePositionsTreeTimingsFiltered: T['tree']['locations']['filtered'], // @ts-expect-error migration
        callFramePositionsTreeTimestamps: T['tree']['locations']['bounds'], // @ts-expect-error migration

        callFramesTimings: T['dict']['callFrames']['all'], // @ts-expect-error migration
        callFramesTimingsFiltered: T['dict']['callFrames']['filtered'], // @ts-expect-error migration
        callFramesTreeTimings: T['tree']['callFrames']['all'], // @ts-expect-error migration
        callFramesTreeTimingsFiltered: T['tree']['callFrames']['filtered'], // @ts-expect-error migration
        callFramesTreeTimestamps: T['tree']['callFrames']['bounds'], // @ts-expect-error migration

        modulesTimings: T['dict']['modules']['all'], // @ts-expect-error migration
        modulesTimingsFiltered: T['dict']['modules']['filtered'], // @ts-expect-error migration
        modulesTreeTimings: T['tree']['modules']['all'], // @ts-expect-error migration
        modulesTreeTimingsFiltered: T['tree']['modules']['filtered'], // @ts-expect-error migration
        modulesTreeTimestamps: T['tree']['modules']['bounds'], // @ts-expect-error migration

        packagesTimings: T['dict']['packages']['all'], // @ts-expect-error migration
        packagesTimingsFiltered: T['dict']['packages']['filtered'], // @ts-expect-error migration
        packagesTreeTimings: T['tree']['packages']['all'], // @ts-expect-error migration
        packagesTreeTimingsFiltered: T['tree']['packages']['filtered'], // @ts-expect-error migration
        packagesTreeTimestamps: T['tree']['packages']['bounds'], // @ts-expect-error migration

        categoriesTimings: T['dict']['categories']['all'], // @ts-expect-error migration
        categoriesTimingsFiltered: T['dict']['categories']['filtered'], // @ts-expect-error migration
        categoriesTreeTimings: T['tree']['categories']['all'], // @ts-expect-error migration
        categoriesTreeTimingsFiltered: T['tree']['categories']['filtered'], // @ts-expect-error migration
        categoriesTreeTimestamps: T['tree']['categories']['bounds']
    };
}
