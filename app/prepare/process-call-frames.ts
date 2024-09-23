import {
    engineNodeNames,
    knownChromeExtensions,
    knownRegistry,
    maxRegExpLength,
    typeOrder,
    vmStateNodeTypes,
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
    V8CpuProfileExecutionContext,
    CpuProFunctionKind
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

function resolveCategory(moduleType: ModuleType): ReferenceCategory {
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
        entry.type = engineNodeNames.get(functionName as WellKnownName) || entry.wellKnown;
        entry.name = functionName;
    } else if (!url || url.startsWith('evalmachine.')) {
        if (scriptId === 0) {
            if (functionName.startsWith('RegExp: ')) {
                entry.ref = '(regexp)';
                entry.type = 'regexp';
                entry.name = '(regexp)';
            } else {
                const engineType = engineNodeNames.get(functionName  as WellKnownName);

                if (engineType !== undefined) {
                    entry.ref = functionName;
                    entry.type = engineType;
                    entry.name = functionName;
                } else {
                    entry.type = 'internals';
                    entry.name = '(internals)';
                }
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
    } else if (url.startsWith('v8/')) {
        entry.type = 'v8';
        entry.path = url;
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

function resolveFunctionKind(name: string, regexp: string | null, moduleRef: ReferenceModule): CpuProFunctionKind {
    if (moduleRef.wellKnown === 'root') {
        return 'root';
    }

    if (moduleRef.wellKnown !== null && vmStateNodeTypes.has(moduleRef.wellKnown)) {
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
    };
}

export function processCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: V8CpuProfileScript[] = [],
    scriptById: Map<number, CpuProScript>,
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
    const wellKnownCallFrames: Record<Extract<'root' | 'program' | 'idle', WellKnownType>, CpuProCallFrame | null> = {
        root: null,
        program: null,
        idle: null
    };

    // input
    const inputCallFrames = [...callFrames]; // make a copy to not pollute original callFrames array
    const scriptById = new Map<number, V8CpuProfileScript>();

    for (const script of scripts) {
        scriptById.set(script.id, script);
    }

    // create callFrames from script functions to produce function/module/package/category instantes for compiled code
    for (const fn of scriptFunctions) {
        const script = fn.script !== null ? scriptById.get(fn.script) || null : null;

        if (script !== null) {
            inputCallFrames.push(createCpuProFrame(
                inputCallFrames.length + 1,
                script.id,
                script.url,
                fn.name,
                fn.line,
                fn.column
            ));
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

            if (moduleRef.wellKnown !== null && Object.hasOwn(wellKnownCallFrames, moduleRef.wellKnown)) {
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
                : functionName || (lineNumber === 0 && columnNumber === 0
                    ? '(script)'
                    : `(anonymous function #${functions.anonymous++})`
                );

            functions.set(functionRef, callFrameFunction = {
                id: functions.size + 1, // id starts with 1
                name,
                category: callFrameModule.category,
                package: callFrameModule.package,
                module: callFrameModule,
                kind: resolveFunctionKind(name, regexp, moduleRef),
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
