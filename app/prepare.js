import { OLD_COMPUTATIONS, TIMINGS, typeColor, typeColorComponents, typeOrder } from './prepare/const.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { gcReparenting, processSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { buildTrees } from './prepare/build-trees.js';
import { CallTree } from './prepare/call-tree.js';

function remapId(node, index) {
    node.id = index + 1;
}

// fastest way to find max id
function findMaxId(nodes) {
    let maxId = nodes[nodes.length - 1].id;

    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id > maxId) {
            maxId = nodes[i].id;
        }
    }

    return maxId;
}

export default function(data, { rejectData, defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    const markAsArea = defineObjectMarker('area', { ref: 'name', title: 'name', page: 'area' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });
    let timestamp = Date.now();
    let markTimeStep = null;
    const markTime = TIMINGS
        ? (name) => {
            const newTimestamp = Date.now();
            if (markTimeStep !== null) {
                console.log('>', markTimeStep, newTimestamp - timestamp);
            }
            markTimeStep = name;
            timestamp = newTimestamp;
        }
        : () => null;

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

    markTime('find max node ID');
    let maxNodeId = findMaxId(data.nodes);

    markTime('convert samples and timeDeltas into TypeArrays');
    const samples = new Uint32Array(data.samples);
    const timeDeltas = new Int32Array(data.timeDeltas);

    markTime('processTimeDeltas()');
    const {
        startTime,
        startOverheadTime,
        endTime,
        totalTime
    } = processTimeDeltas(timeDeltas, samples, data.startTime, data.endTime);

    markTime('gcReparenting()');
    maxNodeId = gcReparenting(samples, data.nodes, maxNodeId);

    markTime('processNodes()');
    const {
        callFrames,
        callFramesTree
    } = processNodes(data.nodes, maxNodeId);

    markTime('processCallFrames()');
    const {
        wellKnownCallFrames,
        areas,
        packages,
        modules,
        functions
    } = processCallFrames(callFrames);

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
    addQueryHelpers({
        order(value) {
            return typeOrder[value] || 100;
        },
        color(value, comp) {
            const dict = comp ? typeColorComponents : typeColor;
            return dict[value] || dict.unknown;
        },
        totalPercent(value) {
            const percent = 100 * value / totalTime;
            return percent >= 0.1 ? percent.toFixed(2) + '%' : '<0.1%';
        },
        duration(value) {
            const percent = 100 * value / totalTime;
            return (value / 1000).toFixed(1) + 'ms' + (percent >= 0.01 ? ' / ' + percent.toFixed(2) + '%' : '');
        },
        ms(value) {
            return (value / 1000).toFixed(1) + 'ms';
        },
        select(tree, type, ...args) {
            if (tree instanceof CallTree) {
                let iterator;

                switch (type) {
                    case 'nodes':
                        iterator = tree.selectNodes(...args);
                        break;
                    case 'children':
                        iterator = tree.children(...args);
                        break;
                    case 'ancestors':
                        iterator = tree.ancestors(...args);
                        break;
                }

                if (iterator !== undefined) {
                    return [...tree.map(iterator)];
                }
            }
        },
        binCalls(_, tree, test, n = 500) {
            const { samples, timeDeltas, totalTime } = this.context.data;
            const { dictionary, nodes, mapToIndex } = tree;
            const mask = new Uint8Array(tree.dictionary.length);
            const bins = new Float64Array(n);
            const step = totalTime / n;
            let end = step;
            let binIdx = 0;

            for (let i = 0; i < mask.length; i++) {
                const accept = typeof test === 'function'
                    ? test(dictionary[i])
                    : test === dictionary[i];
                if (accept) {
                    mask[i] = 1;
                }
            }

            for (let i = 0, offset = 0; i < samples.length; i++) {
                const accept = mask[nodes[mapToIndex[samples[i]]]];
                const delta = timeDeltas[i];

                if (offset + delta < end) {
                    if (accept) {
                        bins[binIdx] += delta;
                    }
                } else {
                    if (accept) {
                        const dx = end - offset;
                        let x = delta - dx;
                        let i = 1;
                        while (x > step) {
                            bins[binIdx + i] = step;
                            i++;
                            x -= step;
                        }

                        bins[binIdx] += dx;
                        bins[binIdx + i] = x;
                    }

                    while (offset + delta > end) {
                        binIdx += 1;
                        end += step;
                    }
                }

                offset += delta;
            }

            // let sum = 0;
            // for (let i = 0; i < bins.length; i++) {
            //     sum += bins[i];
            //     // bins[i] /= step;
            // }
            // bins[0] = step;

            return Array.from(bins);
        },
        groupByCallSiteRef: `
            group(=>callFrame.ref).({
                grouped: value,
                ...value[],
                children: value.children,
                selfTime: value.sum(=>selfTime),
                totalTime: value | $ + ..children | .sum(=>selfTime),
            })
        `
    });

    // annotations for struct view
    addValueAnnotation('#.key = "selfTime" and $ and { text: duration() }');
    addValueAnnotation('#.key = "totalTime" and $ and { text: duration() }');

    markTime('producing result');
    const areasSet = new Set(areas.map(area => area.name));
    const result = {
        meta: {
            engine: 'V8',
            runtime:
                areasSet.has('electron') ? 'Electron'
                    : areasSet.has('node') ? 'Node.js'
                        : areasSet.has('chrome-extension') ? 'Chromium'
                            : 'Unknown'
        },
        // nodes: data.nodes,
        // nodeById: data.nodes.reduce((m, x, idx) => ((m[x.id] = idx), m), Object.create(null)),
        startTime,
        startOverheadTime,
        endTime,
        totalTime,
        wellKnownCallFrames,
        callFrames,
        callFramesTree,
        areas,
        areasTree,
        packages,
        packagesTree,
        modules,
        modulesTree,
        functions,
        functionsTree,
        samples,
        samplesCount: samples.length,
        samplesInterval: timeDeltas.slice().sort()[timeDeltas.length >> 1], // TODO: speedup
        timeDeltas
    };

    markTime('finish');

    return result;
}
