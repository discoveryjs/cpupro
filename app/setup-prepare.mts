import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { convertToUint32Array } from './prepare/utils.js';
import { extractAndValidate } from './prepare/index.js';
import { processNodes } from './prepare/preprocessing/nodes.js';
import { processPaths } from './prepare/preprocessing/paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { mergeSamples, processSamples, remapTreeSamples } from './prepare/preprocessing/samples.js';
import { processTimeDeltas } from './prepare/preprocessing/time-deltas.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/computations/build-trees.js';
import { Dictionary } from './prepare/dictionary.js';
import { consumeInput } from './prepare/consume-input.js';

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
    // Populate shared dictionary
    //
    const dict = new Dictionary();
    const {
        nodeIndexById: nodeIndexById_,
        callFrameByNodeIndex: callFrameByNodeIndex_,
        scriptFunctions
    } = await work('consume dictionaries', () =>
        consumeInput(
            dict,
            data.nodes,
            data._callFrames,
            data._scripts,
            data._functions,
            data._functionCodes,
            data._executionContexts
        )
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
    // Process profile data
    //

    // preprocess timeDeltas, fix order if necessary
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
        rawSamplePositions: Array.isArray(data._samplePositions) ? convertToUint32Array(data._samplePositions) : null
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

    //
    // Create profile's data derivatives
    //

    const {
        nodeParent,
        nodeIndexById,
        callFrameByNodeIndex
    } = await work('process nodes', () =>
        processNodes(
            dict,
            data.nodes,
            nodeIndexById_,
            callFrameByNodeIndex_,
            samples
        )
    );


    // build trees should be performed after dictionaries are sorted and remaped
    const {
        treeSource,
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = await work('build trees', () =>
        buildTrees(
            nodeParent,
            nodeIndexById,
            callFrameByNodeIndex,
            dict.callFrames,
            // ---
            dict.functions,
            dict.modules,
            dict.packages,
            dict.categories
        )
    );

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    await work('remap tree samples', () =>
        remapTreeSamples(
            samples,
            treeSource.sourceIdToNode,
            functionsTree,
            modulesTree,
            packagesTree,
            categoriesTree
        )
    );

    // build samples lists & trees
    const {
        samplesTimings,
        samplesTimingsFiltered,
        functionsTimings,
        functionsTimingsFiltered,
        functionsTreeTimings,
        functionsTreeTimingsFiltered,
        functionsTreeTimestamps,
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
            functionsTree,
            modulesTree,
            packagesTree,
            categoriesTree
        )
    );

    // apply object marker
    await work('mark objects', () => {
        dict.callFrames.forEach(markers.callFrame);
        dict.functions.forEach(markers.function);
        dict.modules.forEach(markers.module);
        dict.packages.forEach(markers.package);
        dict.categories.forEach(markers.category);
        dict.scripts.forEach(markers.script);
        scriptFunctions.forEach(markers['script-function']);
    });

    const profile = {
        runtime: detectRuntime(dict.categories, dict.packages, data._runtime), // FIXME: categories/packages must be related to profile
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
        functionsTimings,
        functionsTimingsFiltered,
        functionsTree,
        functionsTreeTimings,
        functionsTreeTimingsFiltered,
        functionsTreeTimestamps,
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
        functions: dict.functions,
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
