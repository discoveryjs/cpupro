import { buildSegments } from './prepare/build-segments.js';
import { convertValidate } from './prepare/index.js';

const maxRegExpLength = 65;
const wellKnownNodeName = new Map([
    ['(root)', 'root'],
    ['(program)', 'program'],
    ['(garbage collector)', 'gc'],
    ['(idle)', 'idle']
]);
const knownChromeExtensions = {
    'fmkadmapgofadopljbjfkapdkoienihi': 'React Developer Tools',
    'lmhkpmbekcpmknklioeibfkpmmfibljd': 'Redux DevTools',
    'nhdogjmejiglipccpnnnanhbledajbpd': 'Vue.js devtools',
    'ienfalfjdbdpebioblfackkekamfmbnh': 'Angular DevTools',
    'jdkknkkbebbapilgoeccciglkfbmbnfm': 'Apollo Client Devtools',
    'hcikjlholajopgbgfmmlbmifdfbkijdj': 'Rempl',
    'pamhglogfolfbmlpnenhpeholpnlcclo': 'JsonDiscovery',
    'jlmafbaeoofdegohdhinkhilhclaklkp': 'OctoLinker',
    'dhdgffkkebhmkfjojejmpbldmpobfkfo': 'Tampermonkey'
};
const typeColor = {
    'node': '#78b362a0',
    'electron': '#9feaf9a0',
    'script': '#fee29ca0',
    'npm': '#f98e94a0',
    'wasm': '#9481ffa0',
    'garbage collector': '#f1b6fda0',
    'garbage-collector': '#f1b6fda0',
    'regexp': '#8db2f8a0',
    'internals': '#fcb69aa0',
    'program': '#edfdd1a0',
    'chrome-extension': '#7dfacda0',
    'root': '#444444a0',
    'unknown': '#888888a0'
};
const typeColorComponents = Object.fromEntries(Object.entries(typeColor)
    .map(([type, color]) =>[type, color
        .match(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/)
        .slice(1)
        .map(hex => parseInt(hex, 16))
    ])
);
const typeOrder = Object.fromEntries(Object.keys(typeColor).map((type, idx) => [type, idx + 1]));

function maxNodesId(array) {
    let maxId = 0;

    for (const { id } of array) {
        if (id > maxId) {
            maxId = id;
        }
    }

    return maxId;
}

function getLongestCommonPath(longestCommonModulePath, modulePath) {
    let parts = modulePath.split(/\//);

    // drop filename
    parts.pop();

    const result = longestCommonModulePath !== null
        ? longestCommonModulePath.slice(0, Math.min(longestCommonModulePath.length, parts.length))
        : parts;
    parts = parts.slice(0, result.length);

    for (let i = result.length - 1; i >= 0; i--) {
        if (result[i] !== parts[i]) {
            result.pop();
        }
    }

    return result;
}

function resolveModuleRef(cache, cacheKey, scriptId, url, functionName) {
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    const isWellKnownNode = scriptId === 0 && wellKnownNodeName.has(functionName);
    const entry = {
        ref: url || scriptId,
        type: null,
        name: null,
        path: null,
        protocol: null
    };

    if (isWellKnownNode) {
        entry.ref = functionName;
        entry.type = functionName.slice(1, -1);
        entry.name = functionName;
    } else if (!url || url.startsWith('evalmachine.')) {
        if (scriptId === 0) {
            if (functionName.startsWith('RegExp: ')) {
                entry.type = 'regexp';
                entry.name = '(regexp)';
                entry.ref = entry.name;
            } else {
                entry.type = 'internals';
                entry.name = '(internals)';
            }
        } else {
            if (!cache.anonymous.has(scriptId)) {
                cache.anonymous.set(scriptId, `(anonymous module #${cache.anonymous.size + 1})`);
            }

            entry.type = 'script';
            entry.name = cache.anonymous.get(scriptId);
        }
    } else if (url.startsWith('node:electron/') || url.startsWith('electron/')) {
        entry.type = 'electron';
        entry.path = url;
    } else if (url.startsWith('webpack/runtime/')) {
        entry.type = 'webpack/runtime';
        entry.path = url;
    } else {
        entry.protocol = (url.match(/^([a-z\-]+):/i) || [])[1] || '';

        if (entry.protocol.length === 1 && /[A-Z]/.test(entry.protocol)) {
            entry.protocol = '';
            url = url.slice(2).replace(/\\/g, '/');
        }

        switch (entry.protocol) {
            case '':
                entry.type = 'script';
                entry.path = 'file://' + url;
                break;

            case 'file':
            case 'http':
            case 'https':
                entry.type = 'script';
                entry.path = url;
                break;

            case 'webpack':
            case 'webpack-internal':
                entry.type = 'bundle';
                entry.path = url;
                break;

            case 'node':
            case 'chrome-extension':
            case 'wasm':
                entry.type = entry.protocol;
                entry.path = url;
                break;

            default:
                entry.type = `protocol-${entry.protocol}`;
                entry.name = url;
        }
    }

    cache.set(cacheKey, entry);

    return entry;
}

function resolvePackageRef(cache, moduleRef) {
    if (cache.has(moduleRef)) {
        return cache.get(moduleRef);
    }

    const entry = {
        ref: null,
        type: null,
        name: null,
        path: null
    };

    switch (moduleRef.type) {
        case 'script':
        case 'bundle': {
            if (/\/node_modules\//.test(moduleRef.path || '')) {
                // use a Node.js path convention
                const pathParts = moduleRef.path.split(/\/node_modules\//);
                const npmPackageName = (pathParts.pop().match(/(?:@[^/]+\/)?[^/]+/) || [])[0];

                if (npmPackageName) {
                    const path = [...pathParts, npmPackageName].join('/node_modules/');

                    entry.ref = path;
                    entry.type = 'npm';
                    entry.name = npmPackageName;
                    entry.path = path;
                }
            }

            if (!entry.name) {
                entry.type = 'script';

                if (/^https?:/.test(moduleRef.path)) {
                    const url = new URL(moduleRef.path);

                    entry.ref = url.origin;
                    entry.name = url.host;
                    entry.path = url.origin;
                } else if (moduleRef.path) {
                    entry.ref = '(script)';
                    entry.name = '(script)';
                    entry.path = moduleRef.path ? moduleRef.path.slice(0, moduleRef.path.indexOf(':') + 1) : '';
                } else {
                    entry.ref = '(compiled script)';
                    entry.name = '(compiled script)';
                }
            }

            break;
        }

        case 'regexp': {
            entry.ref = '(regexp)';
            entry.type = 'regexp';
            entry.name = '(regexp)';
            entry.path = '';
            break;
        }

        case 'node': {
            entry.ref = '(node)';
            entry.type = 'node';
            entry.name = '(node.js modules)';
            entry.path = 'node:';

            break;
        }

        // case 'blink':
        // case 'v8':
        case 'webpack/runtime':
        case 'electron': {
            entry.ref = `(${moduleRef.type})`;
            entry.type = moduleRef.type;
            entry.name = `(${moduleRef.type} modules)`;
            entry.path = `${moduleRef.type}/`;

            break;
        }

        case 'wasm': {
            entry.ref = '(wasm)';
            entry.type = 'wasm';
            entry.name = '(wasm)';

            break;
        }

        case 'chrome-extension': {
            const url = new URL(moduleRef.path);

            entry.ref = url.origin;
            entry.type = 'chrome-extension';
            entry.name = knownChromeExtensions.hasOwnProperty(url.host)
                ? knownChromeExtensions[url.host]
                : url.host;
            entry.path = url.origin;

            break;
        }

        case 'root':
        case 'program':
        case 'garbage collector':
        case 'idle':
        case 'internals':
            entry.ref = moduleRef.type;
            entry.type = moduleRef.type.replace(/\s/g, '-');
            entry.name = `(${moduleRef.type})`;
            break;

            // case 'root':
            // case 'program':
            // case 'garbage collector':
            // case 'idle':
            //     entry.ref = moduleRef.type;
            //     entry.type = moduleRef.type.slice(1, -1).replace(/\s/g, '-');
            //     entry.name = moduleRef.type;
            //     break;

        default:
            entry.ref = 'unknown';
            entry.type = 'unknown';
            entry.name = '(unknown)';
    }

    cache.set(moduleRef, entry);

    return entry;
}

function createPackage(id, type, name, path, area) {
    return {
        id,
        type,
        name,
        path,
        area,
        selfTime: 0,
        totalTime: 0,
        modules: [],
        calls: [],
        recursiveCalls: []
    };
}

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

function refLineColumn(value) {
    return typeof value !== 'number' || value < 0 ? '' : value;
}

// Fixes negative deltas in a `timeDeltas` array and ensures the integrity and chronological order of the associated samples.
// It adjusts the deltas to ensure all values are non-negative by redistributing negative deltas across adjacent elements.
// Additionally, it corrects the order of associated samples to match the adjusted timing.
function fixNegativeTimeDeltas({ timeDeltas, samples }) {
    for (let i = 0; i < timeDeltas.length; i++) {
        const delta = timeDeltas[i];

        // check if the current delta is negative
        if (delta < 0) {
            // if not the last element, add the current negative delta to the next delta to correct the sequence
            if (i < timeDeltas.length - 1) {
                timeDeltas[i + 1] += delta;
            }

            // set the current delta to 0 if it's the first element, otherwise invert the negative delta to positive
            timeDeltas[i] = i === 0 ? 0 : -delta;

            // if not the first element, adjust the previous delta to include the current negative delta
            if (i > 0) {
                timeDeltas[i - 1] += delta;

                // swap the current and previous samples to reflect the adjusted timing
                const sample = samples[i];
                samples[i] = samples[i - 1];
                samples[i - 1] = sample;

                // move back two indices to re-evaluate the previous delta in case it became negative due to the adjustment
                i -= 2;
            }
        }
    }
}

function gcReparenting(data) {
    const gcNode = data.nodes.find(node =>
        node.callFrame.functionName === '(garbage collector)'
    );

    if (gcNode === undefined) {
        return;
    }

    const gcNodeId = gcNode.id;
    const stackToGc = new Map();
    let id = 1 + data.nodes.reduce(
        (max, node) => node.id > max ? node.id : max,
        data.nodes[0].id
    );

    for (let i = 0, prevNodeId = -1; i < data.samples.length; i++) {
        const nodeId = data.samples[i];

        if (nodeId === gcNodeId) {
            if (prevNodeId === gcNodeId) {
                data.samples[i] = data.samples[i - 1];
            } else {
                if (stackToGc.has(prevNodeId)) {
                    data.samples[i] = stackToGc.get(prevNodeId);
                } else {
                    const parentNode = data.nodes[prevNodeId];
                    const newGcNodeId = id++;
                    const newGcNode = {
                        id: newGcNodeId,
                        callFrame: { ...gcNode.callFrame }
                    };

                    stackToGc.set(prevNodeId, newGcNodeId);
                    data.nodes.push(newGcNode);
                    data.samples[i] = newGcNodeId;

                    if (parentNode.children) {
                        parentNode.children.push(newGcNodeId);
                    } else {
                        parentNode.children = [newGcNodeId];
                    }
                }
            }
        }

        prevNodeId = nodeId;
    }
}

export default function(data, { rejectData, defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    data = convertValidate(data, rejectData);

    fixNegativeTimeDeltas(data);
    gcReparenting(data);

    const markAsArea = defineObjectMarker('area', { ref: 'name', title: 'name', page: 'area' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });
    const markAsNode = defineObjectMarker('node');
    const areas = new Map();
    const noPackage = createPackage(1, null, '(no package)', null);
    const packages = new Map([[null, noPackage]]);
    const packageRefCache = new Map();
    const modules = new Map();
    const moduleRefCache = Object.assign(new Map(), { anonymous: new Map() });
    const functions = Object.assign(new Map(), { anonymous: 0 });
    const scriptIdFromString = new Map();
    const urlByScriptId = new Map();
    const maxId = maxNodesId(data.nodes);
    const selfTimes = new Uint32Array(maxId + 1);
    const nodeById = new Array(maxId + 1);
    const nodeSegments = Array.from({ length: maxId + 1 }, () => []);
    const roots = [];
    const wellKnownNodes = {
        root: null,
        program: null,
        idle: null,
        gc: null
    };
    let unknownTypeOrder = typeOrder.unknown;
    let longestCommonModulePath = null;
    let totalTime = Math.max(data.timeDeltas[0], 0);

    markAsPackage(noPackage);

    // precompute self time and time segments
    for (let i = 1; i < data.timeDeltas.length; i++) {
        const delta = data.timeDeltas[i];
        const nodeId = data.samples[i];

        selfTimes[nodeId] += delta;
        totalTime += delta;
    }

    // normalize scriptId
    for (const { callFrame } of data.nodes) {
        let { scriptId } = callFrame;

        // ensure scriptId is a number
        // some tools are generating scriptId as a stringified number
        if (typeof scriptId === 'string') {
            if (/^\d+$/.test(scriptId)) {
                // the simplest case: a stringified number, convert it to a number
                scriptId = Number(scriptId);
            } else {
                // handle cases where scriptId is represented as an URL or a string in the format ":number"
                let numericScriptId = scriptIdFromString.get(scriptId);

                if (numericScriptId === undefined) {
                    scriptIdFromString.set(scriptId, numericScriptId = /^:\d+$/.test(scriptId)
                        ? Number(scriptId.slice(1))
                        : -scriptIdFromString.size - 1
                    );
                }

                scriptId = numericScriptId;
            }

            callFrame.scriptId = scriptId;
        }

        // address a known issue where some callFrames lack a URL;
        // if a URL exists, associate it with its scriptId for reference
        if (callFrame.url) {
            urlByScriptId.set(scriptId, callFrame.url);
        }
    }

    // process nodes
    for (const node of data.nodes) {
        // fix missed call frame url
        if (!node.callFrame.url && urlByScriptId.has(node.callFrame.scriptId)) {
            node.callFrame.url = urlByScriptId.get(node.callFrame.scriptId);
        }

        const { scriptId, functionName, url, lineNumber, columnNumber } = node.callFrame;
        const functionRef = `${scriptId}:${functionName}:${lineNumber}:${columnNumber}:${url}`;

        // FIXME: is there a more performant way for this?
        node.callFrame.ref = `${functionName}:${refLineColumn(lineNumber)}:${refLineColumn(columnNumber)}:${url || scriptId}`;

        const moduleRef = resolveModuleRef(moduleRefCache, functionRef, scriptId, url, functionName);

        // module
        if (modules.has(moduleRef.ref)) {
            node.module = modules.get(moduleRef.ref);
        } else {
            const areaType = moduleRef.type === 'bundle' || moduleRef.type === 'webpack/runtime' ? 'script' : moduleRef.type;
            let moduleArea = areas.get(areaType);
            const packageRef = resolvePackageRef(packageRefCache, moduleRef);
            let modulePackage = packages.get(packageRef.ref);

            // auto-create module's area (cluster) if needed
            if (moduleArea === undefined) {
                areas.set(areaType, moduleArea = {
                    id: typeOrder[areaType] || unknownTypeOrder++,
                    name: areaType,
                    selfTime: 0,
                    totalTime: 0,
                    calls: [],
                    recursiveCalls: []
                });

                markAsArea(moduleArea);
            }

            // auto-create module's package if needed
            if (modulePackage === undefined) {
                packages.set(packageRef.ref, modulePackage = createPackage(
                    packages.size + 1, // id starts with 1
                    packageRef.type,
                    packageRef.name,
                    packageRef.path,
                    moduleArea
                ));

                markAsPackage(modulePackage);
            }

            // create module
            modules.set(moduleRef.ref, node.module = {
                id: modules.size + 1, // id starts with 1
                type: moduleRef.type,
                name: moduleRef.name,
                path: moduleRef.path,
                package: modulePackage,
                packageRelPath: null,
                area: moduleArea,
                selfTime: 0,
                totalTime: 0,
                functions: [],
                calls: [],
                recursiveCalls: []
            });

            markAsModule(node.module);
            modulePackage.modules.push(node.module);

            // module path processing
            const modulePath = node.module.path || '';

            if (modulePath) {
                if (node.module.package.type === 'script' && node.module.package.path === 'file:') {
                    longestCommonModulePath = getLongestCommonPath(longestCommonModulePath, modulePath);
                }
            }
        }

        // function
        if (functions.has(functionRef)) {
            node.function = functions.get(functionRef);
        } else {
            const isRegExp = node.module.package.type === 'regexp';
            const regexp = isRegExp ? functionName.slice('RegExp: '.length) : null;
            const name = regexp
                ? (regexp.length <= maxRegExpLength ? regexp : `${regexp.slice(0, maxRegExpLength - 1)}…`)
                : functionName || `(anonymous function #${functions.anonymous++})`;

            functions.set(functionRef, node.function = {
                id: functions.size + 1, // id starts with 1
                name,
                module: node.module,
                regexp,
                loc: node.module.path ? `${node.module.path}:${lineNumber}:${columnNumber}` : null,
                selfTime: 0,
                totalTime: 0,
                calls: [],
                recursiveCalls: []
            });

            markAsFunction(node.function);
            node.module.functions.push(node.function);

            if (scriptId === 0 && wellKnownNodeName.has(functionName)) {
                wellKnownNodes[wellKnownNodeName.get(functionName)] = node;
            }
        }

        // finalize updates

        nodeById[node.id] = node;
        markAsNode(node);

        node.parent = null;
        node.selfTime = selfTimes[node.id];
        node.totalTime = null;
        node.segments = nodeSegments[node.id];
    }

    if (wellKnownNodes.idle) {
        wellKnownNodes.idle.selfTime += data.timeDeltas[0];
    }

    // collect roots & process children (replace an ID with a node)
    for (const node of data.nodes) {
        if (node.parent === null) {
            roots.push(node);
        }

        if (!Array.isArray(node.children)) {
            node.children = [];
        }

        for (let i = 0; i < node.children.length; i++) {
            const child = nodeById[Number(node.children[i])];

            if (child === undefined) {
                throw new Error(`Bad child id #${node.children[i]} for node #${node.id}`);
            }

            if (child.parent !== null) {
                throw new Error(`More than one parent for node #${node.children[i]}`);
            }

            child.parent = node;
            node.children[i] = child;
        }
    }

    // total time (can be computed only when selfTime for each node is set)
    for (const node of roots) {
        node.totalTime = computeNodeTotal(node);
    }

    // delete (no package) if no modules attached to it
    if (noPackage.modules.length === 0) {
        packages.delete(null);
    }

    // shorthand paths
    if (longestCommonModulePath !== null && longestCommonModulePath.length > 0) {
        longestCommonModulePath = longestCommonModulePath.join('/');

        for (const pkg of packages.values()) {
            if (pkg.type === 'script' && pkg.path === 'file:') {
                pkg.path = longestCommonModulePath;
            }
        }

        for (const fn of functions.values()) {
            if (fn.loc && fn.loc.startsWith(longestCommonModulePath + '/')) {
                fn.loc = './' + fn.loc.slice(longestCommonModulePath.length + 1);
            }
        }
    }

    for (const module of modules.values()) {
        const modulePath = module.path || '';

        if (module.package.path && modulePath.startsWith(module.package.path)) {
            module.packageRelPath = modulePath
                .slice(module.package.path.length)
                .replace(/^[\/\\]+/, '');
        }
    }

    // mutate data
    data.samplesCount = data.samples.length;
    data.samplesInterval = data.timeDeltas.slice().sort()[data.timeDeltas.length >> 1];
    data.endTime = data.startTime + totalTime; // there is often a small delta as result of rounding/precision in samples
    data.totalTime = totalTime;

    Object.assign(data, wellKnownNodes);

    // profile meta
    data.meta = {
        engine: 'V8',
        runtime:
            areas.has('electron') ? 'Electron'
                : areas.has('node') ? 'Node.js'
                    : areas.has('chrome-extension') ? 'Chromium'
                        : 'Unknown'
    };

    // build node types tree & aggregate timinigs
    data.areas = [...areas.values()].sort((a, b) => a.id < b.id ? -1 : 0);
    data.areaTree = aggregateNodes(wellKnownNodes.root, areas, node => node.module.area);

    // build package tree & aggregate timinigs
    data.packages = [...packages.values()].sort((a, b) => a.name < b.name ? -1 : 1);
    data.packageTree = aggregateNodes(wellKnownNodes.root, packages, node => node.module.package);

    // build module tree & aggregate timinigs
    data.modules = [...modules.values()].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1);
    data.moduleTree = aggregateNodes(wellKnownNodes.root, modules, node => node.module);

    // aggregate function timinigs
    data.functions = [...functions.values()];
    data.functionTree = aggregateNodes(wellKnownNodes.root, functions, node => node.function);

    // build segments
    // data.naturalTree = buildSegments(data, nodeById, wellKnownNodes.gc);

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

    return data;
}
