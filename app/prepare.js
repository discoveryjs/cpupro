import { OLD_COMPUTATIONS, TIMINGS, typeColor, typeColorComponents, typeOrder } from './prepare/const.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { gcReparenting, processSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';
import { buildTrees } from './prepare/build-trees.js';

function remapId(node, index) {
    node.id = index + 1;
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
    gcReparenting(samples, data.nodes);

    markTime('processNodes()');
    const {
        callFrames,
        callFramesTree,
        nodeById
    } = processNodes(data.nodes);

    markTime('processCallFrames()');
    const {
        wellKnownCallFrames,
        areas,
        packages,
        modules,
        functions
    } = processCallFrames(callFrames);

    markTime('processSamples()');
    processSamples(samples, nodeById);

    markTime('processPaths()');
    processPaths(packages, modules, functions);

    // TODO: delete after completing the comparison with the previous version for temporary analysis purposes
    if (OLD_COMPUTATIONS) {
        if (wellKnownCallFrames.idle) {
            samples[0] = wellKnownCallFrames.idle.id - 1;
        } else {
            timeDeltas[0] = 0;
        }
    }

    markTime('sorting & marking');
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
        areasTree,
        packagesTree,
        modulesTree,
        functionsTree
    } = buildTrees(
        callFramesTree,
        areas,
        packages,
        modules,
        functions,
        samples,
        timeDeltas
    );

    // // build node types tree & aggregate timinigs
    // data.areas = [...areas.values()].sort((a, b) => a.id < b.id ? -1 : 0);
    // data.areaTree = aggregateNodes(wellKnownCallFrames.root, areas, node => node.module.area);

    // // build package tree & aggregate timinigs
    // data.packages = [...packages.values()].sort((a, b) => a.name < b.name ? -1 : 1);
    // data.packageTree = aggregateNodes(wellKnownCallFrames.root, packages, node => node.module.package);

    // // build module tree & aggregate timinigs
    // data.modules = [...modules.values()].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1);
    // data.moduleTree = aggregateNodes(wellKnownCallFrames.root, modules, node => node.module);

    // // aggregate function timinigs
    // data.functions = [...functions.values()];
    // data.functionTree = aggregateNodes(wellKnownCallFrames.root, functions, node => node.function);

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
        binCalls(_, fn = () => true, n = 500) {
            const { samples, timeDeltas } = this.context.data;
            const bins = new Float64Array(n);
            const step = this.context.data.totalTime / n;
            let end = step;
            let binIdx = 0;

            for (let i = 0, offset = 0; i < samples.length; i++) {
                const node = i === 0 && wellKnownCallFrames.idle ? wellKnownCallFrames.idle : nodeById[samples[i]];
                const accept = typeof fn === 'function' ? fn(node) : true;
                const delta = Math.max(timeDeltas[i], 0);

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
    const areasSet = new Set(areas.map(m => m.name));
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
        callFrames,
        wellKnownCallFrames,
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
