import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { convertToInt32Array, convertToUint32Array } from './prepare/utils.js';
import { extractAndValidate } from './prepare/index.js';
import { mergeSamples, processSamples, remapTreeSamples } from './prepare/preprocessing/samples.js';
import { processTimeDeltas } from './prepare/preprocessing/time-deltas.js';
import { reparentGcNodes } from './prepare/preprocessing/gc-samples.js';
import { extractCallFrames } from './prepare/preprocessing/call-frames.js';
import { processNodes } from './prepare/preprocessing/nodes.js';
import { processFunctionCodes } from './prepare/preprocessing/function-codes.js';
import { processPaths } from './prepare/preprocessing/paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { processCallFramePositions } from './prepare/preprocessing/call-frame-positions.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/computations/build-trees.js';
import { ProfileScriptsMap } from './prepare/preprocessing/scripts.js';
import { Dictionary } from './prepare/dictionary.js';
import { Usage } from './prepare/usage.js';

export default (async function(input: unknown, { rejectData, markers, setWorkTitle }: PrepareContextApi) {
    const work = async function<T>(name: string, fn: () => T): Promise<T> {
        await setWorkTitle(name);
        const startTime = Date.now();

        try {
            return fn();
        } finally {
            TIMINGS && console.info('>', name, Date.now() - startTime);
        }
    };

    //
    // Extract & validate profile data
    //
    const data = await work('extract profile data', () =>
        extractAndValidate(input, rejectData)
    );

    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    //
    // Create shared dictionary
    //
    const dict = new Dictionary();

    // execution context goes first sice it affects package name
    // FIXME: following profiles could affect previously loaded profiles,
    // it should perform together with path/name processing
    for (const { origin, name } of data._executionContexts || []) {
        dict.setPackageNameForOrigin(new URL(origin).host, name);
    }

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
            data.timeDeltas,
            data.samples,
            data.startTime,
            data.endTime,
            data._samplePositions,
            data._samplesInterval // could be computed on V8 log convertation into cpuprofile
        )
    );

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    const {
        rawSamples,
        rawTimeDeltas,
        rawSamplePositions
    } = await work('convert samples and timeDeltas into TypeArrays', () => ({
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
    const gcNodes = await work('reparent GC samples', () =>
        reparentGcNodes(data.nodes, data._callFrames || null, samples, samplePositions)
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
            gcNodes
        )
    );

    // process function codes
    const scriptFunctions = await work('process function codes', () =>
        processFunctionCodes(data._functionCodes, callFrameByFunctionIndex, dict.callFrames)
    );

    // process paths
    await work('process module paths', () =>
        processPaths(dict.packages, dict.modules)
    );

    // process display names
    await work('process display names', () =>
        processDisplayNames(dict.modules)
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
        processNodes(data.nodes, gcNodes)
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

    // build trees should be performed after dictionaries are sorted and remaped
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
            positionsTreeSource
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
        processSamples(
            samples,
            timeDeltas,
            callFramesTree,
            modulesTree,
            packagesTree,
            categoriesTree,
            callFramePositionsTree
        )
    );

    // apply object marker
    await work('mark objects', () => {
        dict.callFrames.forEach(markers['call-frame']);
        callFramePositionsTree?.dictionary.forEach(markers['call-frame-position']);
        dict.modules.forEach(markers.module);
        dict.packages.forEach(markers.package);
        dict.categories.forEach(markers.category);
        dict.scripts.forEach(markers.script);
        scriptFunctions.forEach(markers['script-function']);
    });

    const profile = {
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
        samplePositions,
        samplesTimings,
        samplesTimingsFiltered,
        timeDeltas: samplesTimings.timeDeltas,
        scriptFunctions,
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

    const result = {
        scripts: dict.scripts,
        callFrames: dict.callFrames,
        modules: dict.modules,
        packages: dict.packages,
        categories: dict.categories,

        profiles: [
            profile
        ],

        '--': '--legacy---',

        ...profile
    };

    return result;
} satisfies PrepareFunction);
