import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { convertToUint32Array } from './prepare/utils.js';
import { extractAndValidate } from './prepare/index.js';
import { mergeSamples, processSamples, remapTreeSamples } from './prepare/preprocessing/samples.js';
import { processTimeDeltas } from './prepare/preprocessing/time-deltas.js';
import { reparentGcNodes } from './prepare/preprocessing/gc-samples.js';
import { consumeCallFrames } from './prepare/consume-input.js';
import { processNodes } from './prepare/preprocessing/nodes.js';
import { processFunctionCodes } from './prepare/preprocessing/function-codes.js';
import { processPaths } from './prepare/preprocessing/paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/computations/build-trees.js';
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
            ? convertToUint32Array(data._samplePositions)
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
    } = await work('consume dictionaries', () =>
        consumeCallFrames(
            dict,
            data.nodes,
            gcNodes,
            data._callFrames,
            data._scripts,
            data._functions,
            data._executionContexts
        )
    );

    // preprocess function codes
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

    const { nodeIndexById, nodeParent } = await work('process nodes', () =>
        processNodes(data.nodes, gcNodes)
    );

    //
    // Create profile's data derivatives
    //

    // build trees should be performed after dictionaries are sorted and remaped
    const {
        treeSource,
        callFramesTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = await work('build trees', () =>
        buildTrees(
            nodeParent,
            nodeIndexById,
            callFrameByNodeIndex,
            dict
        )
    );

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    await work('remap tree samples', () =>
        remapTreeSamples(
            samples,
            treeSource.sourceIdToNode,
            callFramesTree,
            modulesTree,
            packagesTree,
            categoriesTree
        )
    );

    // build samples lists & trees
    const {
        samplesTimings,
        samplesTimingsFiltered,
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
            categoriesTree
        )
    );

    // apply object marker
    await work('mark objects', () => {
        dict.callFrames.forEach(markers['call-frame']);
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
