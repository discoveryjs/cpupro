import { TIMINGS } from './prepare/const.js';
import { convertToUint32Array, createMarkTime, findMaxId, remapId } from './prepare/utils.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { processDisplayNames } from './prepare/process-module-names.js';
import { gcReparenting, mergeSamples, processSamples, remapTreeSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/build-trees.js';
import { processScripts } from './prepare/process-scripts.js';
import { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { processFunctions } from './prepare/process-functions.js';

export default (function(input: unknown, { rejectData, markers }: PrepareContextApi) {
    const markTime = TIMINGS ? createMarkTime() : () => undefined;

    markTime('convertValidate()');
    const data = convertValidate(input, rejectData);

    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    markTime('find max node ID');
    let maxNodeId = findMaxId(data.nodes);

    markTime('processTimeDeltas()');
    const {
        startTime,
        startNoSamplesTime,
        endTime,
        endNoSamplesTime,
        totalTime,
        samplesInterval
    } = processTimeDeltas(
        data.timeDeltas,
        data.samples,
        data.startTime,
        data.endTime,
        data._samplesInterval // could be computed on V8 log convertation into cpuprofile
    );

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    markTime('convert samples and timeDeltas into TypeArrays');
    const rawSamples = convertToUint32Array(data.samples);
    const rawTimeDeltas = convertToUint32Array(data.timeDeltas);
    const rawSamplePositions = Array.isArray(data._samplePositions) ? convertToUint32Array(data._samplePositions) : null;

    // merge samples
    markTime('merge samples');
    const {
        samples,
        sampleCounts,
        samplePositions,
        timeDeltas
    } = mergeSamples(rawSamples, rawTimeDeltas, rawSamplePositions);

    // GC nodes reparenting should be performed before node processing since it adds additional nodes
    markTime('gcReparenting()');
    maxNodeId = gcReparenting(samples, data.nodes, maxNodeId);

    // preprocess scripts if any
    markTime('processScripts()');
    const {
        scripts,
        scriptById
    } = processScripts(data._scripts);

    markTime('processFunctions()');
    const {
        scriptFunctions
    } = processFunctions(data._functions, scriptById);

    markTime('processNodes()');
    const {
        callFrames,
        callFramesTree
    } = processNodes(data.nodes, maxNodeId);


    // callFrames -> functions, modules, packages, categories
    markTime('processCallFrames()');
    const {
        wellKnownCallFrames,
        categories,
        packages,
        modules,
        functions
    } = processCallFrames(
        callFrames,
        scripts,
        scriptById,
        scriptFunctions,
        data._executionContexts
    );

    // process dictionaries
    markTime('processPaths()');
    processPaths(packages, modules);

    // process display names
    markTime('processDisplayNames()');
    processDisplayNames(modules);

    // sort dictionaries and remap ids in ascending order
    markTime('sort dictionaries & remap ids');
    functions.forEach(remapId);
    modules.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : (a.path || '') < (b.path || '') ? -1 : 1).forEach(remapId);
    packages.sort((a, b) => a.name < b.name ? -1 : 1).forEach(remapId);
    categories.sort((a, b) => a.id < b.id ? -1 : 1).forEach(remapId);

    // build trees should be performed after dictionaries are sorted and remaped
    markTime('buildTrees()');
    const {
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    } = buildTrees(
        callFramesTree,
        functions,
        modules,
        packages,
        categories
    );

    // apply object marker
    markTime('apply discovery object markers');
    callFrames.forEach(markers.callFrame);
    functions.forEach(markers.function);
    modules.forEach(markers.module);
    packages.forEach(markers.package);
    categories.forEach(markers.category);
    scripts.forEach(markers.script);
    scriptFunctions.forEach(markers['script-function']);

    // re-map samples
    // FIXME: remap callFramesTree only, before buildTrees()?
    markTime('remap tree samples');
    remapTreeSamples(
        samples,
        callFramesTree,
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    );

    // build samples lists & trees
    markTime('processSamples()');
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
    } = processSamples(
        samples,
        timeDeltas,
        callFramesTree,
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    );

    markTime('producing result');
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

    markTime('finish');

    return result;
} satisfies PrepareFunction);
