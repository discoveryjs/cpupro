import { OLD_COMPUTATIONS, TIMINGS } from './prepare/const.js';
import { convertToUint32Array, createMarkTime, findMaxId, remapId } from './prepare/utils.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { gcReparenting, processSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { buildTrees } from './prepare/build-trees.js';
import joraQueryHelpers from './prepare/jora-methods.js';

export default function(data, { rejectData, defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    const markAsArea = defineObjectMarker('area', { ref: 'name', title: 'name', page: 'area' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });
    const markTime = TIMINGS ? createMarkTime() : () => undefined;

    markTime('convertValidate()');
    data = convertValidate(data, rejectData);
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

    // callFrames -> functions, modules, packages, areas
    markTime('processCallFrames()');
    const {
        wellKnownCallFrames,
        areas,
        packages,
        modules,
        functions
    } = processCallFrames(callFrames);

    // process dictionaries
    markTime('processPaths()');
    processPaths(packages, modules, functions);

    markTime('sorting & marking hierarchy nodes');
    areas.sort((a, b) => a.id < b.id ? -1 : 0).forEach(remapId);
    areas.forEach(markAsArea);

    packages.sort((a, b) => a.name < b.name ? -1 : 1).forEach(remapId);
    packages.forEach(markAsPackage);

    modules.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1).forEach(remapId);
    modules.forEach(markAsModule);

    functions.forEach(remapId);
    functions.forEach(markAsFunction);

    // build trees should be performed after dictionaries are sorted and remaped
    markTime('buildTrees()');
    const {
        functionsTree,
        modulesTree,
        packagesTree,
        areasTree
    } = buildTrees(
        callFramesTree,
        functions,
        modules,
        packages,
        areas
    );

    markTime('processSamples()');
    // TODO: delete after completing the comparison with the previous version for temporary analysis purposes
    if (OLD_COMPUTATIONS) {
        if (wellKnownCallFrames.idle) {
            samples[0] = wellKnownCallFrames.idle.id - 1;
        } else {
            timeDeltas[0] = 0;
        }
    }
    processSamples(
        samples,
        timeDeltas,
        callFramesTree,
        functionsTree,
        modulesTree,
        packagesTree,
        areasTree
    );

    // extend jora's queries with custom methods
    addQueryHelpers(joraQueryHelpers);

    // annotations for struct view
    addValueAnnotation('#.key = "selfTime" and $ and { text: duration() }');
    addValueAnnotation('#.key = "totalTime" and $ and { text: duration() }');

    markTime('producing result');
    const areasSet = new Set(areas.map(area => area.name));
    const result = {
        engine: 'V8',
        runtime:
            areasSet.has('electron') ? 'Electron'
                : areasSet.has('node') ? 'Node.js'
                    : areasSet.has('chrome-extension') ? 'Chromium'
                        : 'Unknown',
        startTime,
        startOverheadTime,
        endTime,
        totalTime,
        nodesCount,
        wellKnownCallFrames,
        callFrames,
        callFramesTree,
        functions,
        functionsTree,
        modules,
        modulesTree,
        packages,
        packagesTree,
        areas,
        areasTree,
        samples,
        samplesCount,
        samplesInterval: timeDeltas.slice().sort()[timeDeltas.length >> 1], // TODO: speedup
        timeDeltas
    };

    markTime('finish');

    return result;
}
