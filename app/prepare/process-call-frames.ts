import {
    engineNodeNames,
    knownChromeExtensions,
    knownRegistry,
    maxRegExpLength,
    typeOrder,
    vmStateNodeTypes,
    wellKnownNodeName
} from './const.js';
import { locFromLineColumn } from './process-functions.js';
import { sortScriptFunctions } from './process-scripts.js';
import type {
    CpuProCallFrame,
    CpuProCategory,
    CpuProPackage,
    CpuProModule,
    CpuProFunction,
    CpuProScript,
    CpuProFunctionKind,
    ModuleType,
    PackageType,
    WellKnownName,
    WellKnownType,
    PackageRegistry,
    CDN,
    V8CpuProfileExecutionContext,
    CpuProScriptFunction
} from './types.js';

type RegistryPackage = {
    type: PackageType;
    name: string;
    path: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
}
type Dict = {
    modules: Map<number | string, CpuProModule>;
    anonymousModuleByScriptId: Map<number, string>
    nameByOrigin: Map<string, string>;
    packages: Map<string, CpuProPackage>;
    categories: Map<string, CpuProCategory> & {
        unknownTypeOrder: number;
    };
}

function resolveCategory(dict: Dict, moduleType: ModuleType): CpuProCategory {
    const name = moduleType === 'bundle' || moduleType === 'webpack/runtime'
        ? 'script'
        : moduleType;
    let category = dict.categories.get(name);

    if (category === undefined) {
        dict.categories.set(name, category = {
            id: typeOrder[name] || dict.categories.unknownTypeOrder++,
            name
        });
    }

    return category;
}

function resolveRegistryPackage(modulePath: string): RegistryPackage | null {
    const moduleUrl = /^https?:\/\//.test(modulePath) ? new URL(modulePath) : null;

    if (moduleUrl !== null && Object.hasOwn(knownRegistry, moduleUrl.origin)) {
        const registry = knownRegistry[moduleUrl.origin];
        const registryPath = moduleUrl.pathname;

        for (const endpoint of registry.endpoints) {
            const packageMatch = registryPath.match(endpoint.pattern);

            if (packageMatch !== null) {
                const packageName = packageMatch.groups?.pkg || '?';
                const version = packageMatch.groups?.version || null;
                const pathOffset = packageMatch.indices?.groups?.path?.[0] ?? registryPath.length;

                return {
                    type: 'script',
                    name: packageName,
                    path: moduleUrl.origin + (pathOffset !== undefined ? registryPath.slice(0, pathOffset) : registryPath),
                    version,
                    registry: endpoint.registry,
                    cdn: registry.cdn
                };
            }
        }
    }

    if (/\/node_modules\//.test(modulePath)) {
        // use a Node.js path convention
        const pathParts = modulePath.split(/\/node_modules\//);
        const pathLastPart = pathParts.pop() || '';
        const npmPackageNameMatch = pathLastPart.match(/(?:@[^/]+\/)?[^/]+/);

        if (npmPackageNameMatch !== null) {
            const npmPackageName = npmPackageNameMatch[0];
            const npmPackagePath = [...pathParts, npmPackageName].join('/node_modules/');

            return {
                type: 'script',
                name: npmPackageName,
                path: npmPackagePath,
                version: null,
                registry: 'npm',
                cdn: null
            };
        }
    }

    return null;
}

function resolvePackage(
    dict: Dict,
    moduleType: ModuleType,
    modulePath: string | null
): CpuProPackage {
    let pkg = dict.packages.get(`${moduleType}/${modulePath}`);

    if (pkg !== undefined) {
        return pkg;
    }

    let ref = 'unknown';
    let type: PackageType = 'unknown';
    let name = '(unknown)';
    let path: string | null = null;
    let version: string | null = null;
    let registry: PackageRegistry | null = null;
    let cdn: CDN | null = null;

    modulePath = modulePath || '';

    switch (moduleType) {
        case 'script':
        case 'bundle': {
            const packageInfo = resolveRegistryPackage(modulePath);

            if (packageInfo !== null) {
                ref = packageInfo.path;
                type = packageInfo.type;
                name = packageInfo.name;
                path = packageInfo.path;
                version = packageInfo.version;
                registry = packageInfo.registry;
                cdn = packageInfo.cdn;
            }

            if (ref === 'unknown') {
                type = 'script';

                if (/^https?:/.test(modulePath)) {
                    const { origin, host } = new URL(modulePath);

                    ref = origin;
                    name = host;
                    path = origin;
                } else if (modulePath) {
                    const protocolMatch = modulePath.match(/^[a-z\d]{2,}:/i) || ['file:'];
                    const protocol = protocolMatch[0];

                    if (protocol !== 'file:') {
                        ref = `(${protocol}script)`;
                        name = ref;
                        path = protocol;
                    } else {
                        ref = '(script)';
                        name = ref;
                        path = modulePath.slice(0, modulePath.indexOf(':') + 1);
                    }
                } else {
                    ref = '(compiled script)';
                    name = '(compiled script)';
                }
            }

            break;
        }

        case 'regexp': {
            ref = '(regexp)';
            type = 'regexp';
            name = '(regexp)';
            path = '';

            break;
        }

        case 'node': {
            ref = '(node)';
            type = 'node';
            name = '(node.js modules)';
            path = 'node:';

            break;
        }

        case 'deno': {
            ref = '(deno)';
            type = 'deno';
            name = '(deno modules)';
            path = 'ext:';

            break;
        }

        // case 'blink':
        case 'v8': {
            ref = `(${moduleType})`;
            type = 'internals';
            name = `(${moduleType} modules)`;
            path = `${moduleType}/`;

            break;
        }

        case 'webpack/runtime':
        case 'electron': {
            ref = `(${moduleType})`;
            type = moduleType;
            name = `(${moduleType} modules)`;
            path = `${moduleType}/`;

            break;
        }

        case 'wasm': {
            ref = '(wasm)';
            type = 'wasm';
            name = '(wasm)';
            path = modulePath.startsWith('wasm://wasm/')
                ? 'wasm://wasm/'
                : null;

            break;
        }

        case 'chrome-extension': {
            const url = new URL(modulePath);

            ref = url.origin;
            type = 'chrome-extension';
            name = dict.nameByOrigin.get(url.host) || url.host;
            path = url.origin;

            break;
        }

        case 'root':
        case 'program':
        case 'gc':
        case 'idle':
        case 'internals':
        case 'compilation':
        case 'blocking':
            ref = moduleType;
            type = moduleType;
            name = moduleType !== 'gc' ? `(${moduleType})` : '(garbage collector)';
            break;

            // case 'root':
            // case 'program':
            // case 'garbage collector':
            // case 'idle':
            //     ref = moduleType;
            //     type = moduleType.slice(1, -1).replace(/\s/g, '-');
            //     name = moduleType;
            //     break;
    }

    pkg = dict.packages.get(ref);

    if (pkg === undefined) {
        dict.packages.set(ref, pkg = {
            id: dict.packages.size + 1,
            type,
            name,
            path,
            version,
            registry,
            cdn,
            category: resolveCategory(dict, moduleType)
        });
    }

    return pkg;
}

function createModule(dict: Dict, type: ModuleType, name: string | null, path: string | null = null, scriptId: number = 0) {
    const moduleKey = scriptId === 0 ? name as string : scriptId;
    let module = dict.modules.get(moduleKey);

    if (module === undefined) {
        const pkg = resolvePackage(dict, type, path);
        const category = resolveCategory(dict, type); // FIXME: use pkg.category
        module = {
            id: dict.modules.size + 1, // starts with 1
            type,
            name,
            path,
            category,
            package: pkg,
            packageRelPath: null
        };

        dict.modules.set(moduleKey, module);
    }

    return module;
}

function createModuleFromFunctionName(
    dict: Dict,
    functionName: string
): CpuProModule {
    const wellKnown = wellKnownNodeName.get(functionName as WellKnownName) || null;
    let type: ModuleType = 'unknown';
    let name: string = 'unknown';

    if (wellKnown !== null) {
        type = engineNodeNames.get(functionName as WellKnownName) || wellKnown;
        name = functionName;
    } else {
        if (functionName.startsWith('RegExp: ')) {
            type = 'regexp';
            name = '(regexp)';
        } else {
            const engineType = engineNodeNames.get(functionName  as WellKnownName);

            if (engineType !== undefined) {
                type = engineType;
                name = functionName;
            } else {
                type = 'internals';
                name = '(internals)';
            }
        }
    }

    return createModule(dict, type, name);
}

function createModuleFromScript(
    dict: Dict,
    scriptId: number,
    url: string | null
) {
    let type: ModuleType = 'unknown';
    let name: string | null = null;
    let path: string | null = null;

    // Edge produces call frames with extensions::SafeBuiltins as url for some reasons,
    // ignore such urls - treat as internals
    if (url === 'extensions::SafeBuiltins') {
        url = '';
    }

    if (!url || url.startsWith('evalmachine.')) {
        let anonymousName = dict.anonymousModuleByScriptId.get(scriptId);

        if (anonymousName === undefined) {
            dict.anonymousModuleByScriptId.set(
                scriptId,
                anonymousName = `(anonymous module #${dict.anonymousModuleByScriptId.size + 1})`
            );
        }

        type = 'script';
        name = anonymousName;
    } else if (url.startsWith('v8/')) {
        type = 'v8';
        path = url;
    } else if (url.startsWith('node:electron/') || url.startsWith('electron/')) {
        type = 'electron';
        path = url;
    } else if (url.startsWith('webpack/runtime/')) {
        type = 'webpack/runtime';
        path = url;
    } else {
        let protocol = (url.match(/^([a-z\-]+):/i) || [])[1] || '';

        if (protocol.length === 1 && /[A-Z]/.test(protocol)) {
            protocol = '';
            url = url.slice(2).replace(/\\/g, '/');
        }

        switch (protocol) {
            case '':
                type = 'script';
                path = 'file://' + url;
                break;

            case 'file':
            case 'http':
            case 'https':
                type = 'script';
                path = url;
                break;

            case 'webpack':
            case 'webpack-internal':
                type = 'bundle';
                path = url.replace(/\?$/, '');
                break;

            case 'node':
            case 'chrome-extension':
            case 'wasm':
                type = protocol;
                path = url;
                break;

            case 'ext':
                if (/^ext:(core|cli|runtime|deno)/.test(url)) {
                    type = 'deno';
                    path = url;
                    break;
                }

            default:
                type = `protocol-${protocol}`;
                name = url;
        }
    }

    return createModule(dict, type, name, path, scriptId);
}

function resolveFunctionKind(scriptId: number, name: string, regexp: string | null): CpuProFunctionKind {
    const wellKnown = scriptId === 0 ? wellKnownNodeName.get(name as WellKnownName) || null : null;

    if (wellKnown === 'root') {
        return 'root';
    }

    if (wellKnown !== null && vmStateNodeTypes.has(wellKnown)) {
        return 'vm-state';
    }

    if (regexp !== null) {
        return 'regexp';
    }

    if (name === '(script)') {
        return 'script';
    }

    return 'function';
}

export function createCpuProFrame(
    id: number,
    scriptId: number,
    url: string | null,
    functionName: string,
    lineNumber: number,
    columnNumber: number
): CpuProCallFrame {
    return {
        id,
        scriptId,
        url,
        functionName,
        lineNumber,
        columnNumber,
        // these field will be populated on call frames processing step
        category: null as unknown as CpuProCategory,
        package: null as unknown as CpuProPackage,
        module: null as unknown as CpuProModule,
        function: null as unknown as CpuProFunction,
        script: null as unknown as CpuProScript
    };
}

export function scriptsAndFunctionsFromCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: CpuProScript[],
    scriptById: Map<number, CpuProScript>,
    scriptFunctions: CpuProScriptFunction[] = []
) {
    for (const callFrame of callFrames) {
        const { scriptId, url, functionName, lineNumber, columnNumber } = callFrame;

        if (scriptId !== 0) {
            let script = scriptById.get(scriptId);

            if (script === undefined) {
                script = {
                    id: scriptId,
                    url: url || '',
                    module: null,
                    source: '',
                    compilation: null,
                    functions: []
                };

                scripts.push(script);
                scriptById.set(scriptId, script);
            }

            const scriptFunction: CpuProScriptFunction = {
                id: scriptFunctions.length + 1,
                name: functionName,
                script,
                start: -1,
                end: -1,
                line: lineNumber,
                column: columnNumber,
                loc: locFromLineColumn(lineNumber, columnNumber)
            };

            scriptFunctions.push(scriptFunction);
            script.functions.push(scriptFunction);

            callFrame.url = script.url;
        }
    }

    sortScriptFunctions(scripts);

    return scriptFunctions;
}

export function processCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: CpuProScript[],
    scriptById: Map<number, CpuProScript>,
    scriptFunctions: CpuProScriptFunction[],
    executionContexts: V8CpuProfileExecutionContext[] = []
) {
    // cpuprofile related
    const nameByOrigin = new Map<string, string>([
        ...executionContexts.map(ctx => [new URL(ctx.origin).host, ctx.name]) as [string, string][],
        ...Object.entries(knownChromeExtensions)
    ]);
    const anonymousModuleByScriptId = new Map<number, string>(); // ?? is shared
    const wellKnownCallFrames: Record<Extract<'root' | 'program' | 'idle', WellKnownType>, CpuProCallFrame | null> = {
        root: null,
        program: null,
        idle: null
    };

    // shared dictionaries
    const categories = Object.assign(new Map<string, CpuProCategory>(), { unknownTypeOrder: typeOrder.unknown });
    const functions = Object.assign([] as CpuProFunction[], { anonymous: 0 });
    const dict: Dict = {
        modules: new Map(),
        anonymousModuleByScriptId,
        nameByOrigin,
        packages: new Map(),
        categories
    };

    // main part
    if (scriptFunctions.length === 0) {
        scriptsAndFunctionsFromCallFrames(callFrames, scripts, scriptById, scriptFunctions);
    }

    for (const script of scripts) {
        script.module = createModuleFromScript(dict, script.id, script.url);
    }

    for (const callFrame of callFrames) {
        const { scriptId, functionName, lineNumber, columnNumber } = callFrame;
        const module = scriptId === 0
            ? createModuleFromFunctionName(dict, functionName)
            : dict.modules.get(scriptId) as CpuProModule;

        const isRegExp = module.package.type === 'regexp';
        const regexp = isRegExp ? functionName.slice('RegExp: '.length) : null;
        const name = regexp
            ? (regexp.length <= maxRegExpLength ? regexp : `${regexp.slice(0, maxRegExpLength - 1)}…`)
            : functionName || (lineNumber === 0 && columnNumber === 0
                ? '(script)'
                : `(anonymous function #${functions.anonymous++})`
            );
        const fn = {
            id: functions.length + 1, // id starts with 1
            name,
            category: module.category,
            package: module.package,
            module,
            kind: resolveFunctionKind(scriptId, name, regexp),
            regexp,
            loc: locFromLineColumn(lineNumber, columnNumber)
        };

        functions.push(fn);

        callFrame.script = scriptById.get(scriptId) || null;
        callFrame.module = module;
        callFrame.package = module.package;
        callFrame.category = module.category;
        callFrame.function = fn;

        if (scriptId === 0 && module.name !== null && Object.hasOwn(wellKnownCallFrames, module.name)) {
            wellKnownCallFrames[module.name] = callFrame;
        }
    }

    return {
        categories: [...dict.categories.values()],
        packages: [...dict.packages.values()],
        modules: [...dict.modules.values()],
        functions,
        wellKnownCallFrames
    };
}
