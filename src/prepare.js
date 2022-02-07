const wellKnownNodeName = new Map([
    ['(root)', 'root'],
    ['(program)', 'program'],
    ['(garbage collector)', 'gc'],
    ['(idle)', 'idle']
]);
const knownChromeExtensions = {
    'fmkadmapgofadopljbjfkapdkoienihi': 'React Developer Tools',
    'nhdogjmejiglipccpnnnanhbledajbpd': 'Vue.js devtools',
    'hcikjlholajopgbgfmmlbmifdfbkijdj': 'Rempl'
};

function maxNodesId(array) {
    let maxId = 0;

    for (const { id } of array) {
        if (id > maxId) {
            maxId = id;
        }
    }

    return maxId;
}

function maxSamplesId(array) {
    let maxId = 0;

    for (const id of array) {
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
    } else if (!url) {
        if (scriptId === 0) {
            entry.type = 'internals';
            entry.name = '(internals)';
        } else {
            if (!cache.anonymous.has(scriptId)) {
                cache.anonymous.set(scriptId, `(anonymous module #${cache.anonymous.size + 1})`);
            }

            entry.type = 'script';
            entry.name = cache.anonymous.get(scriptId);
        }
    } else {
        entry.protocol = (url.match(/^([a-z\-]+):/i) || [])[1] || '';

        switch (entry.protocol) {
            case '':
            case 'file':
            case 'http':
            case 'https':
            case 'webpack-internal':
                entry.type = 'script';
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
        case 'script': {
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
                } else {
                    entry.ref = '(script)';
                    entry.name = '(script)';
                    entry.path = moduleRef.path ? moduleRef.path.slice(0, moduleRef.path.indexOf(':') + 1) : '';
                }
            }

            break;
        }

        case 'node': {
            entry.ref = '(node)';
            entry.type = 'node';
            entry.name = '(node.js modules)';
            entry.path = 'node:';

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

function createPackage(id, type, name, path) {
    return {
        id,
        type,
        name,
        path,
        selfTime: 0,
        totalTime: 0,
        parents: null,
        children: null,
        modules: [],
        calls: []
    };
}

function computeNodeTotal(node) {
    if (node.totalTime !== null) {
        return node.totalTime;
    }

    node.totalTime = node.selfTime;

    for (const child of node.children) {
        node.totalTime += computeNodeTotal(child);
    }

    return node.totalTime;
}

function collectCalls(node, getHost, stack, x) {
    const host = getHost(node);

    host.selfTime += node.selfTime;
    if (stack[host.id] === 0) {
        host.calls.push(node);
    }

    stack[host.id]++;

    for (const child of node.children) {
        collectCalls(child, getHost, stack, x);
    }

    stack[host.id]--;
}

function buildChildren(host, getTo, id = { seed: 1 }) {
    if (host.children === null) {
        const childrenMap = new Map();

        host.totalTime = host.selfTime;
        host.parents = [];
        host.children = [];

        for (const call of host.calls) {
            for (const callChild of call.children) {
                const to = getTo(callChild);
                let hostChild = childrenMap.get(to);

                if (hostChild === undefined) {
                    childrenMap.set(to, hostChild = {
                        id: id.seed++,
                        from: host,
                        to,
                        selfTime: 0,
                        totalTime: 0,
                        parents: [],
                        children: buildChildren(to, getTo, id),
                        calls: []
                    });

                    host.children.push(hostChild);
                    to.parents.push(hostChild);
                }

                host.totalTime += callChild.totalTime;
                hostChild.selfTime += callChild.selfTime;
                hostChild.totalTime += callChild.totalTime;
                hostChild.calls.push(callChild);
            }
        }
    }

    return host.children;
}

function buildTree(rootNode, map, getTo) {
    collectCalls(rootNode, getTo, new Uint32Array(map.size + 1));

    for (const entry of map.values()) {
        buildChildren(entry, getTo);
    }
}

export default function(data, { defineObjectMarker, addValueAnnotation, addQueryHelpers }) {
    const markAsNode = defineObjectMarker('node');
    const markAsFunction = defineObjectMarker('function', { ref: 'id', title: 'name', page: 'function' });
    const markAsModule = defineObjectMarker('module', { ref: 'id', title: module => module.name || module.path, page: 'module' });
    const markAsPackage = defineObjectMarker('package', { ref: 'id', title: 'name', page: 'package' });
    const markAsArea = defineObjectMarker('area', { ref: 'name', title: 'name', page: 'area' });
    const noPackage = createPackage(1, null, '(no package)', null);
    const urlByScriptId = new Map();
    const modules = new Map();
    const moduleRefCache = Object.assign(new Map(), { anonymous: new Map() });
    const functions = Object.assign(new Map(), { anonymous: 0 });
    const packages = new Map([[null, noPackage]]);
    const packageRefCache = new Map();
    const areas = new Map();
    const maxId = Math.max(maxNodesId(data.nodes), maxSamplesId(data.samples));
    const selfTimes = new Uint32Array(maxId + 1);
    const nodeById = new Array(maxId + 1);
    const nodeSegments = Array.from({ length: maxId + 1 }, () => []);
    const wellKnownNodes = {
        root: null,
        program: null,
        idle: null,
        gc: null
    };
    let longestCommonModulePath = null;
    let totalTime = 0;

    markAsPackage(noPackage);

    // precompute self time and time segments
    for (let i = 0, lastNodeId = -1, lastSegment = null; i < data.timeDeltas.length; i++) {
        const delta = data.timeDeltas[i];

        // a delta might be negative sometimes, just ignore such samples
        if (delta > 0) {
            const nodeId = data.samples[i];

            selfTimes[nodeId] += delta;

            if (lastNodeId === nodeId) {
                lastSegment[1] += delta;
            } else {
                lastNodeId = nodeId;
                lastSegment = [totalTime, delta];
                nodeSegments[nodeId].push(lastSegment);
            }

            totalTime += delta;
        }
    }

    for (const { callFrame } of data.nodes) {
        // some tools are generating scriptId as a stringified number
        callFrame.scriptId = Number(callFrame.scriptId);

        // fix then issue, when a callFrame sometimes has no url, while another
        // callFrame with the same scriptId might have
        if (callFrame.url) {
            urlByScriptId.set(callFrame.scriptId, callFrame.url);
        }
    }

    // process nodes
    for (const node of data.nodes) {
        // fix missed call frame url
        if (!node.callFrame.url && urlByScriptId.has(node.callFrame.scriptId)) {
            node.callFrame.url = urlByScriptId.get(node.callFrame.scriptId);
        }

        const { scriptId, functionName, url, lineNumber, columnNumber } = node.callFrame;
        const fspath = url.replace(/^file:\/\//, '');
        const functionRef = `${scriptId}:${functionName}:${lineNumber}:${columnNumber}:${url}`;
        const moduleRef = resolveModuleRef(moduleRefCache, functionRef, scriptId, url, functionName);
        const packageRef = resolvePackageRef(packageRefCache, moduleRef);

        // module
        if (modules.has(moduleRef.ref)) {
            node.module = modules.get(moduleRef.ref);
        } else {
            modules.set(moduleRef.ref, node.module = {
                id: modules.size + 1, // id starts with 1
                type: moduleRef.type,
                name: moduleRef.name,
                path: moduleRef.path,
                package: noPackage,
                packageRelPath: null,
                selfTime: 0,
                totalTime: 0,
                parents: null,
                children: null,
                functions: [],
                calls: []
            });
            markAsModule(node.module);

            // node type clusters
            if (!areas.has(node.module.type)) {
                const area = {
                    id: areas.size + 1, // id starts with 1
                    name: node.module.type,
                    selfTime: 0,
                    totalTime: 0,
                    parents: null,
                    children: null,
                    calls: []
                };

                areas.set(node.module.type, area);
                markAsArea(area);
            }

            // package
            if (packages.has(packageRef.ref)) {
                node.module.package = packages.get(packageRef.ref);
            } else {
                packages.set(packageRef.ref, node.module.package = createPackage(
                    packages.size + 1, // id starts with 1
                    packageRef.type,
                    packageRef.name,
                    packageRef.path
                ));
                markAsPackage(node.module.package);
            }

            node.module.package.modules.push(node.module);

            // module path processing
            const modulePath = node.module.path || '';

            if (modulePath) {
                if (node.module.package.type === 'script' && node.module.package.path === '') {
                    longestCommonModulePath = getLongestCommonPath(longestCommonModulePath, modulePath);
                }
            }
        }

        // function
        if (functions.has(functionRef)) {
            node.function = functions.get(functionRef);
        } else {
            functions.set(functionRef, node.function = {
                id: functions.size + 1, // id starts with 1
                name: functionName || `(anonymous function #${functions.anonymous++})`,
                module: node.module,
                loc: fspath ? `${fspath}:${lineNumber}:${columnNumber}` : null,
                selfTime: 0,
                totalTime: 0,
                parents: null,
                children: null,
                calls: []
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

        node.function.selfTime += node.selfTime;
        node.function.totalTime += node.selfTime;
        node.function.calls.push(node);
    }

    // process children (replace an ID with a node)
    for (const node of data.nodes) {
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

    // delete (no package) if no modules attached to it
    if (noPackage.modules.length === 0) {
        packages.delete(null);
    }

    // total time (can be computed only when selfTime for each node is set)
    for (const node of data.nodes) {
        node.totalTime = computeNodeTotal(node);
    }

    // aggregate function timinigs
    for (const fn of functions.values()) {
        buildChildren(fn, node => node.function);
    }

    // build module tree & aggregate timinigs
    buildTree(wellKnownNodes.root, modules, node => node.module);

    // build package tree & aggregate timinigs
    buildTree(wellKnownNodes.root, packages, node => node.module.package);

    // build node types tree & aggregate timinigs
    buildTree(wellKnownNodes.root, areas, node => areas.get(node.module.type));

    // shorthand paths
    if (longestCommonModulePath !== null && longestCommonModulePath.length > 0) {
        longestCommonModulePath = longestCommonModulePath.join('/') + '/';

        for (const pkg of packages.values()) {
            if (pkg.type === 'script' && pkg.path === '') {
                pkg.path = longestCommonModulePath;
            }
        }

        for (const fn of functions.values()) {
            if (fn.loc && fn.loc.startsWith('/')) {
                fn.loc = './' + fn.loc.slice(longestCommonModulePath.length);
            }
        }
    }

    for (const module of modules.values()) {
        const modulePath = module.path || '';

        if (module.package.path && modulePath.startsWith(module.package.path)) {
            module.packageRelPath = modulePath
                .slice(module.package.path.length)
                .replace(/^[\/\\]/, '');
        }
    }

    // extend jora's queries
    addQueryHelpers({
        duration(value) {
            const percent = 100 * value / totalTime;
            return (value / 1000).toFixed(1) + 'ms' + (percent >= 0.01 ? ' / ' + percent.toFixed(2) + '%' : '');
        },
        ms(value) {
            return (value / 1000).toFixed(1) + 'ms';
        }
    });

    // annotations for struct view
    addValueAnnotation('#.key = "selfTime" and $ and { text: duration() }');
    addValueAnnotation('#.key = "totalTime" and $ and { text: duration() }');

    // mutate data
    data.endTime = data.startTime + totalTime; // there is often a small delta as result of rounding/precision in samples
    data.totalTime = totalTime;

    Object.assign(data, wellKnownNodes);

    data.packages = [...packages.values()].sort((a, b) => a.name < b.name ? -1 : 1);
    data.modules = [...modules.values()].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.path < b.path ? -1 : 1);
    data.functions = [...functions.values()];
    data.areas = [...areas.values()];

    delete data.samples;
    delete data.timeDeltas;
}
