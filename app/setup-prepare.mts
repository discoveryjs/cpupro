import { TIMINGS } from './prepare/const.js';
import { convertToUint32Array, remapId } from './prepare/utils.js';
import { extractAndValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { processDisplayNames } from './prepare/process-module-names.js';
import { mergeSamples, processSamples, remapTreeSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/build-trees.js';
import { processScripts } from './prepare/process-scripts.js';
import { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { processFunctions } from './prepare/process-functions.js';

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

    // extract & validate
    const data = await work('extract profile data', () =>
        extractAndValidate(input, rejectData)
    );

    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

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

    // merge samples
    const {
        samples,
        sampleCounts,
        samplePositions,
        timeDeltas
    } = await work('merge samples', () =>
        mergeSamples(rawSamples, rawTimeDeltas, rawSamplePositions)
    );

    // preprocess scripts if any
    const {
        scripts,
        scriptById
    } = await work('processScripts()', () =>
        processScripts(data._scripts)
    );

    const {
        scriptFunctions
    } = await work('processFunctions()', () =>
        processFunctions(data._functions, scriptById)
    );

    const {
        callFrames,
        callFramesTree
    } = await work('process nodes', () =>
        processNodes(data.nodes, data._callFrames, samples)
    );


    // callFrames -> functions, modules, packages, categories
    const {
        wellKnownCallFrames,
        categories,
        packages,
        modules,
        functions
    } = await work('processCallFrames()', () =>
        processCallFrames(
            callFrames,
            scripts,
            scriptById,
            scriptFunctions,
            data._executionContexts
        )
    );

    // process dictionaries
    await work('process paths', () =>
        processPaths(packages, modules)
    );

    // process display names
    await work('process display names', () =>
        processDisplayNames(modules)
    );

    // sort dictionaries and remap ids in ascending order
    await work('sort dictionaries & remap ids', () => {
        functions.forEach(remapId);
        modules.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : (a.path || '') < (b.path || '') ? -1 : 1).forEach(remapId);
        packages.sort((a, b) => a.name < b.name ? -1 : 1).forEach(remapId);
        categories.sort((a, b) => a.id < b.id ? -1 : 1).forEach(remapId);
    });

    // build trees should be performed after dictionaries are sorted and remaped
    const {
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = await work('build trees', () =>
        buildTrees(
            callFramesTree,
            functions,
            modules,
            packages,
            categories
        )
    );

    // apply object marker
    await work('mark objects', () => {
        callFrames.forEach(markers.callFrame);
        functions.forEach(markers.function);
        modules.forEach(markers.module);
        packages.forEach(markers.package);
        categories.forEach(markers.category);
        scripts.forEach(markers.script);
        scriptFunctions.forEach(markers['script-function']);
    });

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    await work('remap tree samples', () =>
        remapTreeSamples(
            samples,
            callFramesTree,
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
            callFramesTree,
            functionsTree,
            modulesTree,
            packagesTree,
            categoriesTree
        )
    );

    const result = {
        runtime: detectRuntime(categories, packages, data._runtime),
        sourceInfo: {
            nodes: nodesCount,
            samples: samplesCount,
            samplesInterval
        },
        scripts,
        scriptFunctions,
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
        wellKnownCallFrames,
        callFrames,
        callFramesTree,
        functions,
        functionsTimings,
        functionsTimingsFiltered,
        functionsTree,
        functionsTreeTimings,
        functionsTreeTimingsFiltered,
        functionsTreeTimestamps,
        modules,
        modulesTimings,
        modulesTimingsFiltered,
        modulesTree,
        modulesTreeTimings,
        modulesTreeTimingsFiltered,
        modulesTreeTimestamps,
        packages,
        packagesTimings,
        packagesTimingsFiltered,
        packagesTree,
        packagesTreeTimings,
        packagesTreeTimingsFiltered,
        packagesTreeTimestamps,
        categories,
        categoriesTimings,
        categoriesTimingsFiltered,
        categoriesTree,
        categoriesTreeTimings,
        categoriesTreeTimingsFiltered,
        categoriesTreeTimestamps,
        heap: data._heap || null
    };

    return result;
} satisfies PrepareFunction);
