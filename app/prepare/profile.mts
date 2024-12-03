import type { Model } from '@discoveryjs/discovery';
import { convertToInt32Array, convertToUint32Array } from './utils.js';
import { mergeSamples, computeTimings, remapTreeSamples } from './preprocessing/samples.js';
import { processLongTimeDeltas, processTimeDeltas } from './preprocessing/time-deltas.js';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { extractCallFrames } from './preprocessing/call-frames.js';
import { processNodes } from './preprocessing/nodes.js';
import { processFunctionCodes } from './preprocessing/function-codes.js';
import { processCallFramePositions } from './preprocessing/call-frame-positions.js';
import { detectRuntime } from './detect-runtime.js';
import { buildTrees } from './computations/build-trees.js';
import { ProfileScriptsMap } from './preprocessing/scripts.js';
import { Dictionary } from './dictionary.js';
import { Usage } from './usage.js';
import { GeneratedNodes, V8CpuProfile } from './types.js';
import { computeCrossProfileUsage } from './computations/cross-profile-usage.mjs';
import { setSamplesConvolutionRule } from './computations/samples-convolution.mjs';

export type Profile = Awaited<ReturnType<typeof createProfile>>;
export type CreateProfileApi = {
    work<T>(name: string, fn: () => T): Promise<T>;
}

export function selectProfile(discovery: Model, profile: Profile) {
    discovery.data = {
        ...discovery.data,
        currentProfile: profile
    };
}

export function toggleProfile(discovery: Model, profile: Profile) {
    const {
        currentProfile,
        profiles,
        allProfiles,
        callFramesProfilePresence,
        currentSamplesConvolutionRule
    } = discovery.data;
    const disable = !profile.disabled;

    if ((disable && profiles.length <= 2) || !allProfiles.includes(profile)) {
        return;
    }

    profile.disabled = !profile.disabled;
    const newProfiles = allProfiles.filter(p => !p.disabled);
    discovery.data = {
        ...discovery.data,
        currentProfile: disable && profile === currentProfile
            ? newProfiles[0] || null
            : currentProfile,
        profiles: newProfiles
    };

    computeCrossProfileUsage(newProfiles, callFramesProfilePresence);
    setSamplesConvolutionRule(newProfiles, callFramesProfilePresence, currentSamplesConvolutionRule);
}

export async function createProfile(data: V8CpuProfile, dict: Dictionary, { work }: CreateProfileApi) {
    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    const generateNodes: GeneratedNodes = {
        dict,
        nodeIdSeed: data.nodes.length + 1,
        noSamplesNodeId: -1,
        callFrames: [],
        nodeParentId: [],
        parentScriptOffsets: [],
        get count() {
            return this.nodeParentId.length;
        }
    };

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
    } = await work('process time deltas', () =>
        processTimeDeltas(
            data.startTime,
            data.endTime,
            data.timeDeltas,
            data.samples,
            data._samplePositions,
            data._samplesInterval // could be computed on V8 log convertation into cpuprofile
        )
    );

    // fix long time deltas
    if (!data._memorySamples) {
        await work('process time deltas', () =>
            processLongTimeDeltas(
                samplesInterval,
                data.timeDeltas,
                data.samples,
                data._samplePositions,
                generateNodes
            )
        );
    }

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    const {
        rawSamples,
        rawTimeDeltas,
        rawSamplePositions
    } = await work('convert samples & timeDeltas into TypedArrays', () => ({
        rawSamples: convertToUint32Array(data.samples),
        rawTimeDeltas: convertToUint32Array(data.timeDeltas),
        rawSamplePositions: Array.isArray(data._samplePositions)
            ? convertToInt32Array(data._samplePositions)
            : null
    }));

    // process samples
    const {
        samples,
        sampleCounts,
        samplePositions,
        timeDeltas
    } = await work('process samples', () =>
        mergeSamples(rawSamples, rawTimeDeltas, rawSamplePositions)
    );

    // attach root GC node samples to previous call stack;
    // this operation produces new nodes
    await work('reparent GC samples', () =>
        reparentGcNodes(
            data.nodes,
            generateNodes,
            data._callFrames || null,
            samples,
            samplePositions
        )
    );

    //
    // Consume dictionaries
    //

    const {
        callFrameByNodeIndex,
        callFrameByFunctionIndex
    } = await work('extract call frames', () =>
        extractCallFrames(
            dict,
            data.nodes,
            data._callFrames,
            data._functions,
            new ProfileScriptsMap(dict, data._scripts),
            generateNodes
        )
    );

    // process function codes
    const {
        codes,
        codesByCallFrame,
        codesByScript
    } = await work('process function codes', () =>
        processFunctionCodes(data._functionCodes, callFrameByFunctionIndex, dict.callFrames)
    );

    //
    // Usage vectors
    //

    const usage = await work('usage', () =>
        new Usage(dict, callFrameByNodeIndex, callFrameByFunctionIndex)
    );

    //
    // Create profile's data derivatives
    //

    const { nodeIndexById, nodeParent, nodePositions } = await work('process nodes', () =>
        processNodes(data.nodes, generateNodes)
    );

    // call frame positions
    const {
        // samplePositions,
        positionsTreeSource
    } = await work('process call frame positions', () =>
        processCallFramePositions(
            nodeIndexById,
            nodeParent,
            nodePositions,
            dict.callFrames,
            callFrameByNodeIndex,
            samples,
            samplePositions
        )
    );

    //
    // Create profile's data derivatives
    //

    const {
        treeSource,
        callFramePositionsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = await work('build trees', () =>
        buildTrees(
            dict,
            nodeParent,
            nodeIndexById,
            callFrameByNodeIndex,
            positionsTreeSource,
            usage
        )
    );
    const callTrees = [
        callFramePositionsTree,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    ].filter(tree => tree !== null);

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    await work('remap samples', () =>
        remapTreeSamples(
            samples,
            positionsTreeSource?.sourceIdToNode || treeSource.sourceIdToNode,
            ...callTrees
        )
    );

    // build samples lists & trees
    const {
        recomputeTimings,
        samplesTimings,
        samplesTimingsFiltered,
        callFramePositionsTimings,
        callFramePositionsTimingsFiltered,
        callFramePositionsTreeTimings,
        callFramePositionsTreeTimingsFiltered,
        callFramePositionsTreeTimestamps,
        callFramesTimings,
        callFramesTimingsFiltered,
        callFramesTreeTimings,
        callFramesTreeTimingsFiltered,
        callFramesTreeTimestamps,
        modulesTimings,
        modulesTimingsFiltered,
        modulesTreeTimings,
        modulesTreeTimingsFiltered,
        modulesTreeTimestamps,
        packagesTimings,
        packagesTimingsFiltered,
        packagesTreeTimings,
        packagesTreeTimingsFiltered,
        packagesTreeTimestamps,
        categoriesTimings,
        categoriesTimingsFiltered,
        categoriesTreeTimings,
        categoriesTreeTimingsFiltered,
        categoriesTreeTimestamps
    } = await work('process samples', () =>
        computeTimings(
            samples,
            timeDeltas,
            callFramesTree,
            modulesTree,
            packagesTree,
            categoriesTree,
            callFramePositionsTree
        )
    );

    const profile = {
        name: data._name,
        disabled: false,
        runtime: detectRuntime(usage.categories, usage.packages, data._runtime), // FIXME: categories/packages must be related to profile
        sourceInfo: {
            nodes: nodesCount,
            samples: samplesCount,
            samplesInterval
        },

        startTime,
        startNoSamplesTime,
        endTime,
        endNoSamplesTime,
        totalTime,

        samples: samplesTimings.samples,
        sampleCounts,
        sampleCountsByProfile: new Uint32Array(),
        samplePositions,
        samplesTimings,
        samplesTimingsFiltered,
        timeDeltas: samplesTimings.timeDeltas,
        timeDeltasByProfile: new Uint32Array(),
        recomputeTimings,

        ...usage,
        codes,
        codesByCallFrame,
        codesByScript,

        positionsTreeSource,
        callFramePositionsTimings,
        callFramePositionsTimingsFiltered,
        callFramePositionsTree,
        callFramePositionsTreeTimings,
        callFramePositionsTreeTimingsFiltered,
        callFramePositionsTreeTimestamps,

        callFramesTimings,
        callFramesTimingsFiltered,
        callFramesTree,
        callFramesTreeTimings,
        callFramesTreeTimingsFiltered,
        callFramesTreeTimestamps,

        modulesTimings,
        modulesTimingsFiltered,
        modulesTree,
        modulesTreeTimings,
        modulesTreeTimingsFiltered,
        modulesTreeTimestamps,

        packagesTimings,
        packagesTimingsFiltered,
        packagesTree,
        packagesTreeTimings,
        packagesTreeTimingsFiltered,
        packagesTreeTimestamps,

        categoriesTimings,
        categoriesTimingsFiltered,
        categoriesTree,
        categoriesTreeTimings,
        categoriesTreeTimingsFiltered,
        categoriesTreeTimestamps,

        heap: data._heap || null
    };

    return profile;
}
