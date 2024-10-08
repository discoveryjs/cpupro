import { locFromLineColumn } from './process-functions';
import {
    engineNodeNames,
    knownChromeExtensions,
    knownRegistry,
    maxRegExpLength,
    typeOrder,
    vmStateNodeTypes,
    wellKnownNodeName
} from './const.js';
import {
    CDN,
    CpuProCallFrame,
    CpuProCategory,
    CpuProFunction,
    CpuProFunctionKind,
    CpuProModule,
    CpuProPackage,
    ModuleType,
    PackageRegistry,
    PackageType,
    V8CpuProfileCallFrame,
    WellKnownName
} from './types.js';
import { createCpuProFrame } from './process-call-frames';

type RegistryPackage = {
    type: PackageType;
    name: string;
    path: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
}

type CallFrameMap = Map<
    number, // scriptId
    Map<
        string, // function name
        Map<
            number, // line
            Map<
                number, // column
                number
            >
        >
    >
>;

export class Dictionary {
    callFrames: CpuProCallFrame[];
    functions: CpuProFunction[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];

    functionsMap: Map<string, CpuProFunction>;
    modulesMap: Map<number | string, CpuProModule>;
    packagesMap: Map<string, CpuProPackage>;
    categoriesMap: Map<string, CpuProCategory>;

    #scriptIdFromString: Map<string, number>;
    #byScriptIdMap: CallFrameMap;
    #anonymousFunctionNameIndex: number = 1;
    #unknownCategoryTypeOrder: number = typeOrder.unknown;
    #anonymousModuleByScriptId: Map<number, string>;
    #packageNameByOriginMap: Map<string, string>;

    constructor() {
        this.callFrames = [];
        this.functions = [];
        this.modules = [];
        this.packages = [];
        this.categories = [];

        this.functionsMap = new Map();
        this.modulesMap = new Map();
        this.packagesMap = new Map();
        this.categoriesMap = new Map();

        this.#byScriptIdMap = new Map();
        this.#anonymousModuleByScriptId = new Map();
        this.#packageNameByOriginMap = new Map([
            ...Object.entries(knownChromeExtensions)
        ]);
    }

    reset() {}

    setPackageNameByOrigin(origin: string, packageName: string) {
        const existingPackageName = this.#packageNameByOriginMap.get(origin);

        if (existingPackageName === undefined) {
            this.#packageNameByOriginMap.set(origin, packageName);
        } else if (existingPackageName !== packageName) {
            console.warn(`Package name for origin "${origin}" already set "${existingPackageName}", new name "${packageName}" ignored`);
        }
    }

    resolveCallFrameIndex(inputCallFrame: V8CpuProfileCallFrame) {
        const functionName = inputCallFrame.functionName || '';
        const lineNumber = normalizeLoc(inputCallFrame.lineNumber);
        const columnNumber = normalizeLoc(inputCallFrame.columnNumber);
        const url = inputCallFrame.url || null;
        let scriptId = inputCallFrame.scriptId;

        // ensure scriptId is a number
        // some tools are generating scriptId as a stringified number
        if (typeof scriptId === 'string') {
            if (/^\d+$/.test(scriptId)) {
                // the simplest case: a stringified number, convert it to a number
                scriptId = Number(scriptId);
            } else {
                // handle cases where scriptId is represented as an URL or a string in the format ":number"
                let numericScriptId = this.#scriptIdFromString.get(scriptId);

                if (numericScriptId === undefined) {
                    this.#scriptIdFromString.set(scriptId, numericScriptId = /^:\d+$/.test(scriptId)
                        ? Number(scriptId.slice(1))
                        : -this.#scriptIdFromString.size - 1
                    );
                }

                scriptId = numericScriptId;
            }
        }

        // resolve a callFrame through a chain of maps
        let byFunctionNameMap = this.#byScriptIdMap.get(scriptId);
        if (byFunctionNameMap === undefined) {
            this.#byScriptIdMap.set(scriptId, byFunctionNameMap = new Map());
        }

        let byLineNumberMap = byFunctionNameMap.get(functionName);
        if (byLineNumberMap === undefined) {
            byFunctionNameMap.set(functionName, byLineNumberMap = new Map());
        }

        let resultMap = byLineNumberMap.get(lineNumber);
        if (resultMap === undefined) {
            byLineNumberMap.set(lineNumber, resultMap = new Map());
        }

        let callFrameIndex = resultMap.get(columnNumber);
        if (callFrameIndex === undefined) {
            const callFrame = createCpuProFrame(
                this.callFrames.length + 1,
                scriptId,
                url,
                functionName,
                lineNumber,
                columnNumber
            );

            callFrameIndex = this.callFrames.push(callFrame) - 1;
            resultMap.set(columnNumber, callFrameIndex);
        }

        return callFrameIndex;
    }
    resolveCallFrame(inputCallFrame: V8CpuProfileCallFrame) {
        return this.callFrames[this.resolveCallFrameIndex(inputCallFrame)];
    }

    resolveCategory(moduleType: ModuleType): CpuProCategory {
        const name = moduleType === 'bundle' || moduleType === 'webpack/runtime'
            ? 'script'
            : moduleType;
        let category = this.categoriesMap.get(name);

        if (category === undefined) {
            category = {
                id: typeOrder[name] || this.#unknownCategoryTypeOrder++,
                name
            };

            this.categoriesMap.set(name, category);
            this.categories.push(category);
        }

        return category;
    }

    resolvePackage(
        moduleType: ModuleType,
        modulePath: string | null
    ): CpuProPackage {
        const canonicalRef = `${moduleType}/${modulePath}`;
        let pkg = this.packagesMap.get(canonicalRef);

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
                const packageRegistryInfo = resolveRegistryPackage(modulePath);

                if (packageRegistryInfo !== null) {
                    ref = packageRegistryInfo.path;
                    type = packageRegistryInfo.type;
                    name = packageRegistryInfo.name;
                    path = packageRegistryInfo.path;
                    version = packageRegistryInfo.version;
                    registry = packageRegistryInfo.registry;
                    cdn = packageRegistryInfo.cdn;
                }

                if (ref === 'unknown') {
                    type = 'script';

                    if (/^https?:/.test(modulePath)) {
                        const { origin, host } = new URL(modulePath);

                        ref = origin;
                        name = this.#packageNameByOriginMap.get(host) || host;
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
                const { origin, host } = new URL(modulePath);

                ref = origin;
                type = 'chrome-extension';
                name = this.#packageNameByOriginMap.get(host) || host;
                path = origin;

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
        }

        pkg = this.packagesMap.get(ref);

        if (pkg === undefined) {
            pkg = {
                id: this.packagesMap.size + 1,
                type,
                name,
                path,
                version,
                registry,
                cdn,
                category: this.resolveCategory(moduleType)
            };

            this.packagesMap.set(canonicalRef, pkg);
            this.packagesMap.set(ref, pkg);
            this.packages.push(pkg);
        }

        return pkg;
    }

    #resolveModule(type: ModuleType, name: string | null, path: string | null = null, scriptId: number = 0) {
        const moduleKey = scriptId === 0 ? name as string : scriptId;
        let module = this.modulesMap.get(moduleKey);

        if (module === undefined) {
            const pkg = this.resolvePackage(type, path);
            const category = this.resolveCategory(type); // FIXME: use pkg.category

            module = {
                id: this.modulesMap.size + 1, // starts with 1
                type,
                name,
                path,
                category,
                package: pkg,
                packageRelPath: null
            };

            this.modulesMap.set(moduleKey, module);
            this.modules.push(module);
        }

        return module;
    }

    resolveNoScriptModuleByFunctionName(functionName: string): CpuProModule {
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

        return this.#resolveModule(type, name);
    }

    resolveModuleByScript(
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
            let anonymousName = this.#anonymousModuleByScriptId.get(scriptId);

            if (anonymousName === undefined) {
                this.#anonymousModuleByScriptId.set(
                    scriptId,
                    anonymousName = `(anonymous module #${this.#anonymousModuleByScriptId.size + 1})`
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

        return this.#resolveModule(type, name, path, scriptId);
    }

    resolveModule(scriptId: number, url: string | null = null, functionName: string | null = null) {
        return scriptId === 0
            ? this.resolveNoScriptModuleByFunctionName(functionName || '')
            : this.resolveModuleByScript(scriptId, url);
    }

    createFunction(
        scriptId: number,
        functionName: string,
        lineNumber: number,
        columnNumber: number
    ) {
        const module = this.resolveModule(scriptId, '' as error, functionName);
        const isRegExp = module.package.type === 'regexp';
        const regexp = isRegExp ? functionName.slice('RegExp: '.length) : null;
        const name = regexp
            ? (regexp.length <= maxRegExpLength ? regexp : `${regexp.slice(0, maxRegExpLength - 1)}…`)
            : functionName || (lineNumber === 0 && columnNumber === 0
                ? '(script)'
                : `(anonymous function #${this.#anonymousFunctionNameIndex++})`
            );

        const fn = {
            id: this.functions.length + 1, // id starts with 1
            name,
            category: module.category,
            package: module.package,
            module,
            kind: resolveFunctionKind(scriptId, name, regexp),
            regexp,
            loc: locFromLineColumn(lineNumber, columnNumber)
        };

        return fn;
    }
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

function normalizeLoc(value: unknown) {
    return typeof value === 'number' && value >= 0 ? value : -1;
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
