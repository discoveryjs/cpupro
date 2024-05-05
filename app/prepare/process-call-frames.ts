import {
    knownChromeExtensions,
    knownRegistry,
    maxRegExpLength,
    typeOrder,
    wellKnownNodeName
} from './const';
import {
    CpuProCallFrame,
    CpuProCategory,
    CpuProPackage,
    CpuProModule,
    CpuProFunction,
    ModuleType,
    PackageType,
    WellKnownName,
    WellKnownType,
    PackageRegistry,
    V8CpuProfileScriptFunction,
    V8CpuProfileScript,
    CDN,
    V8CpuProfileExecutionContext
} from './types';

type ReferenceCategory = {
    ref: string;
    name: string;
};
type RegistryPackage = {
    type: PackageType;
    name: string;
    path: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
}
type ReferencePackage = {
    ref: string;
    type: PackageType;
    name: string;
    path: string | null;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
};
type ReferenceModule = {
    ref: string;
    type: ModuleType;
    name: string | null;
    path: string | null;
    wellKnown: WellKnownType | null;
};

function resolveCategory(moduleType: string): ReferenceCategory {
    const name = moduleType === 'bundle' || moduleType === 'webpack/runtime'
        ? 'script'
        : moduleType;

    return {
        ref: name,
        name
    };
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
    cache: Map<ReferenceModule, ReferencePackage>,
    moduleRef: ReferenceModule,
    nameByOrigin: Map<string, string>
): ReferencePackage {
    let entry = cache.get(moduleRef);

    if (entry !== undefined) {
        return entry;
    }

    const moduleType = moduleRef.type;
    let ref = 'unknown';
    let type: PackageType = 'unknown';
    let name = '(unknown)';
    let path: string | null = null;
    let version: string | null = null;
    let registry: PackageRegistry | null = null;
    let cdn: CDN | null = null;

    switch (moduleType) {
        case 'script':
        case 'bundle': {
            const modulePath = moduleRef.path || '';
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
        // case 'v8':
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
            path = moduleRef.path?.startsWith('wasm://wasm/')
                ? 'wasm://wasm/'
                : null;

            break;
        }

        case 'chrome-extension': {
            const url = new URL(moduleRef.path || '');

            ref = url.origin;
            type = 'chrome-extension';
            name = nameByOrigin.get(url.host) || url.host;
            path = url.origin;

            break;
        }

        case 'root':
        case 'program':
        case 'gc':
        case 'idle':
        case 'internals':
        case 'engine':
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

    cache.set(moduleRef, entry = {
        ref,
        type,
        name,
        path,
        version,
        registry,
        cdn
    });

    return entry;
}

function resolveModule(
    scriptId: number,
    url: string | null,
    functionName: string,
    anonymousModuleByScriptId: Map<number, string>
): ReferenceModule {
    const entry: Exclude<ReferenceModule, 'package' | 'category'> = {
        ref: url || String(scriptId),
        type: 'unknown',
        name: null,
        path: null,
        wellKnown: (scriptId === 0 && wellKnownNodeName.get(functionName as WellKnownName)) || null
    };

    // Edge produces call frames with extensions::SafeBuiltins as url for some reasons,
    // ignore such urls - treat as internals
    if (url === 'extensions::SafeBuiltins') {
        url = '';
    }

    if (entry.wellKnown !== null) {
        entry.ref = functionName;
        entry.type = entry.wellKnown;
        entry.name = functionName;
    } else if (!url || url.startsWith('evalmachine.')) {
        if (scriptId === 0) {
            if (functionName.startsWith('RegExp: ')) {
                entry.ref = '(regexp)';
                entry.type = 'regexp';
                entry.name = '(regexp)';
            } else if (
                functionName === '(parser)' ||
                functionName === '(compiler)' ||
                functionName === '(compiler bytecode)' ||
                functionName === '(atomics wait)'
            ) {
                entry.ref = functionName;
                entry.type = 'engine';
                entry.name = functionName;
            } else {
                entry.type = 'internals';
                entry.name = '(internals)';
            }
        } else {
            let anonymousName = anonymousModuleByScriptId.get(scriptId);

            if (anonymousName === undefined) {
                anonymousModuleByScriptId.set(
                    scriptId,
                    anonymousName = `(anonymous module #${anonymousModuleByScriptId.size + 1})`
                );
            }

            entry.type = 'script';
            entry.name = anonymousName;
        }
    } else if (url.startsWith('node:electron/') || url.startsWith('electron/')) {
        entry.type = 'electron';
        entry.path = url;
    } else if (url.startsWith('webpack/runtime/')) {
        entry.type = 'webpack/runtime';
        entry.path = url;
    } else {
        let protocol = (url.match(/^([a-z\-]+):/i) || [])[1] || '';

        if (protocol.length === 1 && /[A-Z]/.test(protocol)) {
            protocol = '';
            url = url.slice(2).replace(/\\/g, '/');
        }

        switch (protocol) {
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
                entry.path = url.replace(/\?$/, '');
                break;

            case 'node':
            case 'chrome-extension':
            case 'wasm':
                entry.type = protocol;
                entry.path = url;
                break;

            case 'ext':
                if (/^ext:(core|cli|runtime|deno)/.test(url)) {
                    entry.type = 'deno';
                    entry.path = url;
                    break;
                }

            default:
                entry.type = `protocol-${protocol}`;
                entry.name = url;
        }
    }

    return entry;
}

export function processCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: V8CpuProfileScript[] = [],
    scriptFunctions: V8CpuProfileScriptFunction[] = [],
    executionContexts: V8CpuProfileExecutionContext[] = []
) {
    // shared dictionaries
    const categories = Object.assign(new Map<string, CpuProCategory>(), { unknownTypeOrder: typeOrder.unknown });
    const packages = new Map<string, CpuProPackage>();
    const packageRefCache = new Map();
    const modules = new Map<string, CpuProModule>();
    const functions = Object.assign(new Map<string, CpuProFunction>(), { anonymous: 0 });

    // cpuprofile related
    const nameByOrigin = new Map<string, string>([
        ...executionContexts.map(ctx => [new URL(ctx.origin).host, ctx.name]) as [string, string][],
        ...Object.entries(knownChromeExtensions)
    ]);
    const anonymousModuleByScriptId = new Map<number, string>(); // ?? is shared
    const moduleByScriptId = new Map<number, CpuProModule>();
    const wellKnownCallFrames: Record<WellKnownType, CpuProCallFrame | null> = {
        root: null,
        program: null,
        idle: null,
        gc: null
    };

    // input
    const inputCallFrames = [...callFrames];

    for (const fn of scriptFunctions) {
        const scriptIndex = fn.script;
        const script = scriptIndex !== null ? scripts[scriptIndex] || null : null;

        if (script !== null) {
            inputCallFrames.push({
                scriptId: script.id,
                url: script.url,
                functionName: fn.name,
                lineNumber: fn.line,
                columnNumber: fn.column
            } as CpuProCallFrame);
        }
    }

    for (const callFrame of inputCallFrames) {
        const { scriptId, functionName, url, lineNumber, columnNumber } = callFrame;
        const moduleRef = resolveModule(scriptId, url, functionName, anonymousModuleByScriptId);

        let callFrameModule = modules.get(moduleRef.ref);

        // module
        if (callFrameModule === undefined) {
            const categoryRef = resolveCategory(moduleRef.type);
            let moduleCategory = categories.get(categoryRef.ref);
            const packageRef = resolvePackage(packageRefCache, moduleRef, nameByOrigin);
            let modulePackage = packages.get(packageRef.ref);

            // create category (cluster) if needed
            if (moduleCategory === undefined) {
                categories.set(categoryRef.ref, moduleCategory = {
                    id: typeOrder[categoryRef.name] || categories.unknownTypeOrder++,
                    name: categoryRef.name
                });
            }

            // create package if needed
            if (modulePackage === undefined) {
                packages.set(packageRef.ref, modulePackage = {
                    id: packages.size + 1, // starts with 1
                    type: packageRef.type,
                    name: packageRef.name,
                    version: packageRef.version,
                    registry: packageRef.registry,
                    cdn: packageRef.cdn,
                    path: packageRef.path,
                    category: moduleCategory,
                    modules: []
                });
            }

            // create module
            modules.set(moduleRef.ref, callFrameModule = {
                id: modules.size + 1, // starts with 1
                type: moduleRef.type,
                name: moduleRef.name,
                path: moduleRef.path,
                category: moduleCategory,
                package: modulePackage,
                packageRelPath: null,
                functions: []
            });

            modulePackage.modules.push(callFrameModule);

            if (moduleRef.wellKnown !== null) {
                wellKnownCallFrames[moduleRef.wellKnown] = callFrame;
            }
        }

        // function
        const functionRef = `${callFrameModule.id}:${functionName}:${lineNumber}:${columnNumber}`;
        let callFrameFunction = functions.get(functionRef);

        if (callFrameFunction === undefined) {
            const isRegExp = callFrameModule.package.type === 'regexp';
            const regexp = isRegExp ? functionName.slice('RegExp: '.length) : null;
            const name = regexp
                ? (regexp.length <= maxRegExpLength ? regexp : `${regexp.slice(0, maxRegExpLength - 1)}…`)
                : functionName || `(anonymous function #${functions.anonymous++})`;

            functions.set(functionRef, callFrameFunction = {
                id: functions.size + 1, // id starts with 1
                name,
                category: callFrameModule.category,
                package: callFrameModule.package,
                module: callFrameModule,
                regexp,
                loc: lineNumber !== -1 && columnNumber !== -1
                    ? `:${lineNumber}:${columnNumber}`
                    : null
            });

            callFrameModule.functions.push(callFrameFunction);
        }

        moduleByScriptId.set(callFrame.scriptId, callFrameModule);

        callFrame.category = callFrameModule.category;
        callFrame.package = callFrameModule.package;
        callFrame.module = callFrameModule;
        callFrame.function = callFrameFunction;
    }

    return {
        categories: [...categories.values()],
        packages: [...packages.values()],
        modules: [...modules.values()],
        functions: [...functions.values()],
        moduleByScriptId,
        wellKnownCallFrames
    };
}
