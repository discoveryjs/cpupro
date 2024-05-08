import { OLD_COMPUTATIONS, TIMINGS } from './prepare/const.js';
import { convertToUint32Array, createMarkTime, findMaxId, remapId } from './prepare/utils.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { processDisplayNames } from './prepare/process-module-names.js';
import { gcReparenting, processSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { detectRuntime } from './prepare/detect-runtime.js';
import { buildTrees } from './prepare/build-trees.js';
import joraQueryHelpers from './prepare/jora-methods.js';
import { processScripts } from './prepare/process-scripts.js';

export default function(input, { rejectData, defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    const markAsCallFrame = defineObjectMarker('callFrame', { ref: 'id', title: 'name' });
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsCategory = defineObjectMarker('category', { ref: 'name', title: 'name', page: 'category' });
    const markTime = TIMINGS ? createMarkTime() : () => undefined;

    markTime('convertValidate()');
    const data = convertValidate(input, rejectData);
    // let ids = new Set();
    // console.log(data.nodes[0].callFrame);
    // for (let i = 0; i < data.nodes.length; i++) {
    //     const node = data.nodes[i];
    //     if (node.children) {
    //         for (const childId of node.children) {
    //             if (ids.has(childId)) {
    //                 console.log(`Problem ${node.id} -> ${childId}`);
    //             }
    //         }
    //     }
    //     ids.add(node.id);
    // }
    // return data;

    // store source's initial metrics
    const nodesCount = data.nodes.length;
    const samplesCount = data.samples.length;

    markTime('find max node ID');
    let maxNodeId = findMaxId(data.nodes);

    markTime('processTimeDeltas()');
    const {
        startTime,
        startOverheadTime,
        endTime,
        totalTime
    } = processTimeDeltas(data.timeDeltas, data.samples, data.startTime, data.endTime);

    // convert to Uint32Array following the processTimeDeltas() call, as timeDeltas may include negative values,
    // are correcting within processTimeDeltas()
    markTime('convert samples and timeDeltas into TypeArrays');
    const samples = convertToUint32Array(data.samples);
    const timeDeltas = convertToUint32Array(data.timeDeltas);

    // GC nodes reparenting should be performed before node processing since it adds additional nodes
    markTime('gcReparenting()');
    maxNodeId = gcReparenting(samples, data.nodes, maxNodeId);

    markTime('processNodes()');
    const {
        callFrames,
        callFramesTree
    } = processNodes(data.nodes, maxNodeId);

    // callFrames -> functions, modules, packages, categories
    markTime('processCallFrames()');
    const {
        wellKnownCallFrames,
        moduleByScriptId,
        categories,
        packages,
        modules,
        functions
    } = processCallFrames(
        callFrames,
        data.scripts,
        data.scriptFunctions,
        data.executionContexts
    );

    // process dictionaries
    markTime('processPaths()');
    processPaths(packages, modules, functions);

    // process display names
    markTime('processDisplayNames()');
    processDisplayNames(modules);

    // sort dictionaries and remap ids in ascending order
    markTime('sort dictionaries & remap ids');
    functions.forEach(remapId);
    modules.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1).forEach(remapId);
    packages.sort((a, b) => a.name < b.name ? -1 : 1).forEach(remapId);
    categories.sort((a, b) => a.id < b.id ? -1 : 1).forEach(remapId);

    // apply object marker
    markTime('apply discovery object markers');
    callFrames.forEach(markAsCallFrame);
    functions.forEach(markAsFunction);
    modules.forEach(markAsModule);
    packages.forEach(markAsPackage);
    categories.forEach(markAsCategory);

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

    // relink scripts and script functions
    markTime('processScripts()');
    const {
        scripts,
        scriptFunctions
    } = processScripts(data.scripts, data.scriptFunctions, moduleByScriptId);

    markTime('processSamples()');
    // TODO: delete after completing the comparison with the previous version for temporary analysis purposes
    if (OLD_COMPUTATIONS) {
        if (wellKnownCallFrames.idle) {
            samples[0] = wellKnownCallFrames.idle.id - 1;
        } else {
            timeDeltas[0] = 0;
        }
    }
    const {
        samplesTimings,
        samplesTimingsFiltered,
        functionsTimings,
        functionsTimingsFiltered,
        functionsTreeTimings,
        functionsTreeTimingsFiltered,
        modulesTimings,
        modulesTimingsFiltered,
        modulesTreeTimings,
        modulesTreeTimingsFiltered,
        packagesTimings,
        packagesTimingsFiltered,
        packagesTreeTimings,
        packagesTreeTimingsFiltered,
        categoriesTimings,
        categoriesTimingsFiltered,
        categoriesTreeTimings,
        categoriesTreeTimingsFiltered
    } = processSamples(
        samples,
        timeDeltas,
        callFramesTree,
        functionsTree,
        modulesTree,
        packagesTree,
        categoriesTree
    );

    // extend jora's queries with custom methods
    addQueryHelpers(joraQueryHelpers);

    // annotations for struct view
    addValueAnnotation('#.key in ["selfTime", "nestedTime", "totalTime"] and $ and { text: duration() }');

    markTime('producing result');
    const result = {
        runtime: detectRuntime(categories, packages, data.runtime),
        sourceInfo: {
            nodes: nodesCount,
            samples: samplesCount,
            samplesInterval: timeDeltas.slice().sort()[timeDeltas.length >> 1] // TODO: speedup
        },
        scripts,
        scriptFunctions,
        startTime,
        startOverheadTime,
        endTime,
        totalTime,
        samples: samplesTimings.samples,
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
        modules,
        modulesTimings,
        modulesTimingsFiltered,
        modulesTree,
        modulesTreeTimings,
        modulesTreeTimingsFiltered,
        packages,
        packagesTimings,
        packagesTimingsFiltered,
        packagesTree,
        packagesTreeTimings,
        packagesTreeTimingsFiltered,
        categories,
        categoriesTimings,
        categoriesTimingsFiltered,
        categoriesTree,
        categoriesTreeTimings,
        categoriesTreeTimingsFiltered
    };

    markTime('finish');

    return result;
}
