import { typeColor, typeColorComponents, typeOrder } from './prepare/const.js';
import { convertValidate } from './prepare/index.js';
import { processCallFrames } from './prepare/process-call-frames.js';
import { processNodes } from './prepare/process-nodes.js';
import { processPaths } from './prepare/process-paths.js';
import { gcReparenting, processSamples } from './prepare/process-samples.js';
import { processTimeDeltas } from './prepare/process-time-deltas.js';

function computeNodeTotal(node, depth = 1) {
    node.totalTime = node.selfTime;
    node.depth = depth;

    for (const child of node.children) {
        node.totalTime += computeNodeTotal(child, depth + 1);
    }

    return node.totalTime;
}

function collectHostCalls(call, getHost, stack) {
    const host = getHost(call);

    host.selfTime += call.selfTime;
    host.calls.push(call);

    if (stack[host.id] !== 0) {
        host.recursiveCalls.push(call);
    } else {
        host.totalTime += call.totalTime;
    }

    stack[host.id]++;

    for (const childCall of call.children) {
        collectHostCalls(childCall, getHost, stack);
    }

    stack[host.id]--;
}

function buildTree(node, parent, getHost) {
    const host = getHost(node);

    if (parent === null || parent.host !== host) {
        const existing = parent?.children.find(child => child.host === host);
        const newParent = existing || {
            host,
            selfTime: 0,
            totalTime: 0,
            parent,
            children: [],
            nodes: []
        };

        if (parent) {
            parent.totalTime += node.totalTime;
            if (newParent !== existing) {
                parent.children.push(newParent);
            }
        }

        parent = newParent;
    }

    parent.nodes.push(node);
    parent.selfTime += node.selfTime;
    parent.totalTime += node.selfTime;

    for (const child of node.children) {
        buildTree(child, parent, getHost);
    }

    return parent;
}

function aggregateNodes(rootNode, map, getHost) {
    collectHostCalls(rootNode, getHost, new Uint32Array(map.size + 1));

    return buildTree(rootNode, null, getHost);
}

export default function(data, { rejectData, defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    const markAsArea = defineObjectMarker('area', { ref: 'name', title: 'name', page: 'area' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });

    data = convertValidate(data, rejectData);

    const samples = new Uint32Array(data.samples);
    const timeDeltas = new Uint32Array(data.timeDeltas);

    const {
        startTime,
        startOverhead,
        endTime,
        totalTime
    } = processTimeDeltas(timeDeltas, samples, data.startTime, data.endTime);

    gcReparenting(samples, data.nodes);

    const {
        callFrames,
        nodeById,
        nodeCallFrame,
        nodeParent,
        nodeNext,
        nodeNextSibling
    } = processNodes(data.nodes, samples);

    const {
        wellKnownNodes,
        areas,
        packages,
        modules,
        functions
    } = processCallFrames(callFrames);

    processSamples(samples, nodeById);
    processPaths(packages, modules, functions);

    areas.sort((a, b) => a.id < b.id ? -1 : 0);
    areas.forEach(markAsArea);

    packages.sort((a, b) => a.name < b.name ? -1 : 1);
    packages.forEach(markAsPackage);

    modules.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1);
    modules.forEach(markAsModule);

    functions.forEach(markAsFunction);

    // // build node types tree & aggregate timinigs
    // data.areas = [...areas.values()].sort((a, b) => a.id < b.id ? -1 : 0);
    // data.areaTree = aggregateNodes(wellKnownNodes.root, areas, node => node.module.area);

    // // build package tree & aggregate timinigs
    // data.packages = [...packages.values()].sort((a, b) => a.name < b.name ? -1 : 1);
    // data.packageTree = aggregateNodes(wellKnownNodes.root, packages, node => node.module.package);

    // // build module tree & aggregate timinigs
    // data.modules = [...modules.values()].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1);
    // data.moduleTree = aggregateNodes(wellKnownNodes.root, modules, node => node.module);

    // // aggregate function timinigs
    // data.functions = [...functions.values()];
    // data.functionTree = aggregateNodes(wellKnownNodes.root, functions, node => node.function);

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
                const node = i === 0 && wellKnownNodes.idle ? wellKnownNodes.idle : nodeById[samples[i]];
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

    const areasSet = new Set(areas.map(m => m.name));
    return {
        meta: {
            engine: 'V8',
            runtime:
                areasSet.has('electron') ? 'Electron'
                    : areasSet.has('node') ? 'Node.js'
                        : areasSet.has('chrome-extension') ? 'Chromium'
                            : 'Unknown'
        },
        startTime,
        startOverhead,
        endTime,
        totalTime,
        callFrames,
        ...wellKnownNodes,
        areas,
        packages,
        modules,
        functions,
        samples,
        samplesCount: samples.length,
        samplesInterval: timeDeltas.slice().sort()[timeDeltas.length >> 1], // TODO: speedup
        timeDeltas,
        nodeCallFrame,
        nodeParent,
        nodeNext,
        nodeNextSibling
    };
}
