import {
    moduleTypeByWellKnownName,
    knownChromeExtensions,
    knownRegistry,
    maxRegExpLength,
    categories,
    wellKnownCallFrameName,
    wellKnownNameAliases
} from './const.js';
import {
    CDN,
    CpuProCallFrame,
    CpuProCategory,
    CpuProCallFrameKind,
    CpuProLocation,
    CpuProModule,
    CpuProOwner,
    CpuProPackage,
    CpuProScript,
    IProfileScriptsMap,
    ModuleType,
    PackageRegistry,
    PackageType,
    V8CpuProfileCallFrame,
    WellKnownName,
    WellKnownType
} from './types.js';
import { scriptFromScriptId } from './preprocessing/scripts.js';
import { getFunctionAtScriptOffset, getFunctionEndFromScriptLineColumn, getScriptLineColumnFromOffset, getScriptOffsetFromLineColumn } from './misc/parse-source.js';

const callFrameKindPrefixes: [prefix: string, kind: CpuProCallFrameKind][] = [
    ['(builtin) ', 'builtin'],
    ['(IC) ', 'ic'],
    ['(bytecode) ', 'bytecode'],
    ['(LIB) ', 'lib'],
    ['(CPP) ', 'cpp']
];

type RegistryPackage = {
    type: PackageType;
    name: string;
    path: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
}

type CallFrameMap = Map<
    CpuProScript | null, // script
    Map<
        number, // line
        Map<
            number, // column
            Map<
                string, // function name
                number
            >
        >
    >
>;

export class Dictionary {
    callFrames: CpuProCallFrame[] & { wellKnownIndex: Record<WellKnownType, number> };
    locations: CpuProLocation[];
    scripts: CpuProScript[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];
    owners: CpuProOwner[];

    #modulesMap: Map<CpuProScript | string, CpuProModule>;
    #packagesMap: Map<string, CpuProPackage>;
    #categoriesMap: Map<string, CpuProCategory>;
    #ownersMap: Map<string, CpuProOwner>;

    #callFramesByScript: CallFrameMap;
    #scriptCallFrames: WeakMap<CpuProScript, number>;
    #locationsByScriptOffset: WeakMap<CpuProScript, Map<number, number>>;
    #locationsByScriptLineColumn: WeakMap<CpuProScript, Map<number, Map<number, number>>>;
    #locationsByNoScriptCallFrame: Map<CpuProCallFrame, number>;
    #unknownCallFrame: CpuProCallFrame;
    #unknownLocationIndex: number;
    #anonymousFunctionNameIndex: number = 1;
    #anonymousModuleByScriptId: Map<CpuProScript, string>;
    #packageNameByOriginMap: Map<string, string>;
    #unknownOwner: CpuProOwner;

    constructor() {
        this.callFrames = Object.assign([], { wellKnownIndex: Object.create(null) });
        this.locations = [];
        this.scripts = [];
        this.modules = [];
        this.packages = [];
        this.categories = [];
        this.owners = [];

        this.#modulesMap = new Map();
        this.#packagesMap = new Map();
        this.#categoriesMap = new Map();
        this.#ownersMap = new Map();
        this.#unknownOwner = this.resolveOwner('(unknown)'); // goes first as used for modules without owner, including well-known modules/call frames

        this.#callFramesByScript = new Map();
        this.#scriptCallFrames = new WeakMap();
        this.#locationsByScriptOffset = new WeakMap();
        this.#locationsByScriptLineColumn = new WeakMap();
        this.#locationsByNoScriptCallFrame = new Map();
        this.#anonymousModuleByScriptId = new Map();
        this.#packageNameByOriginMap = new Map([
            ...Object.entries(knownChromeExtensions)
        ]);

        // fulfill the category by a known list to preserve an order
        for (const packageType of categories) {
            this.resolveCategory(packageType);
        }

        // fulfill the well known call frames map for fast access
        for (const [name, id] of wellKnownCallFrameName) {
            const callFrameIndex = this.resolveCallFrameIndex({
                scriptId: 0,
                url: '',
                functionName: name,
                lineNumber: -1,
                columnNumber: -1
            }, null as unknown as IProfileScriptsMap);
            const callFrame = this.callFrames[callFrameIndex];

            callFrame.module.owner = this.resolveOwner(callFrame.module.name!);
            this.callFrames.wellKnownIndex[id] = callFrameIndex;
        }

        this.#unknownLocationIndex = this.callFrames.wellKnownIndex.unknown;
        this.#unknownCallFrame = this.callFrames[this.#unknownLocationIndex];
    }

    locationToCallFrame(location: CpuProLocation) {
        return location.callFrame;
    }
    callFrameToModule(callFrame: CpuProCallFrame) {
        return callFrame.module;
    }
    moduleToScript(module: CpuProModule) {
        return module.script;
    }
    moduleToPackage(module: CpuProModule) {
        return module.package;
    }
    packageToCategory(pkg: CpuProPackage) {
        return pkg.category;
    }
    moduleToOwner(module: CpuProModule) {
        return module.owner;
    }

    setPackageNameForOrigin(origin: string, packageName: string) {
        const existingPackageName = this.#packageNameByOriginMap.get(origin);

        if (existingPackageName === undefined) {
            this.#packageNameByOriginMap.set(origin, packageName);
        } else if (existingPackageName !== packageName) {
            console.warn(`Package name for origin "${origin}" already set "${existingPackageName}", new name "${packageName}" ignored`);
        }
    }

    resolveCallFrameIndex(
        inputCallFrame: V8CpuProfileCallFrame,
        scriptsMap: IProfileScriptsMap,
        correctLineColumn = false
    ) {
        const script = scriptFromScriptId(inputCallFrame.scriptId, inputCallFrame.url, scriptsMap);
        return this.#resolveScriptCallFrameIndex(inputCallFrame, script, correctLineColumn);
    }
    #resolveCallFramesByScriptLineColumn(
        script: CpuProScript | null,
        lineNumber: number,
        columnNumber: number
    ) {
        // resolve a callFrame through a chain of maps
        let byLineNumberMap = this.#callFramesByScript.get(script);
        if (byLineNumberMap === undefined) {
            this.#callFramesByScript.set(script, byLineNumberMap = new Map());
        }

        let byColumnNumberMap = byLineNumberMap.get(lineNumber);
        if (byColumnNumberMap === undefined) {
            byLineNumberMap.set(lineNumber, byColumnNumberMap = new Map());
        }

        let callFrameByFunctionName = byColumnNumberMap.get(columnNumber);
        if (callFrameByFunctionName === undefined) {
            byColumnNumberMap.set(columnNumber, callFrameByFunctionName = new Map());
        }

        return callFrameByFunctionName;
    }
    #resolveScriptCallFrameIndex(
        inputCallFrame: V8CpuProfileCallFrame,
        script: CpuProScript | null,
        correctLineColumn = false
    ) {
        const functionName = script !== null
            ? inputCallFrame.functionName || ''
            : wellKnownNameAliases.get(inputCallFrame.functionName as WellKnownName) || inputCallFrame.functionName || '';
        const lineNumber = script !== null ? normalizeLoc(inputCallFrame.lineNumber) : -1;
        const columnNumber = script !== null ? normalizeLoc(inputCallFrame.columnNumber) : -1;
        const scriptLineNumber = correctLineColumn && script !== null && lineNumber !== -1
            ? lineNumber - script.lineOffset
            : lineNumber;
        const scriptColumnNumber = correctLineColumn && script !== null && scriptLineNumber === 0
            ? columnNumber - script.columnOffset
            : columnNumber;
        const callFrameByFunctionName = this.#resolveCallFramesByScriptLineColumn(script, scriptLineNumber, scriptColumnNumber);

        let callFrameIndex = callFrameByFunctionName.get(functionName);
        if (callFrameIndex === undefined) {
            const sourceScript = script;
            const end = normalizeLoc(inputCallFrame.end);
            const start = normalizeLoc(inputCallFrame.start);
            const module = this.resolveModule(sourceScript, functionName);
            const { name, kind, regexp } = this.#resolveFunctionName(functionName, scriptLineNumber, scriptColumnNumber);
            const callFrame: CpuProCallFrame = {
                id: this.callFrames.length + 1,
                script: sourceScript,
                kind: kind || resolveCallFrameKind(sourceScript, name, regexp),
                name,
                origName: functionName,
                line: scriptLineNumber,
                column: scriptColumnNumber,
                loc: locFromLineColumn(scriptLineNumber, scriptColumnNumber),
                start,
                end,
                regexp,
                location: null,
                category: module.category,
                package: module.package,
                module
            };

            setCallFrameLazyStartEndIfNeeded(
                callFrame,
                scriptLineNumber,
                scriptColumnNumber,
                sourceScript,
                start,
                end
            );

            callFrameIndex = this.callFrames.push(callFrame) - 1;
            callFrameByFunctionName.set(functionName, callFrameIndex);
            callFrame.location = this.resolveLocation(callFrame, null, -1, -1, -1);

            if (sourceScript) {
                sourceScript.callFrames.push(callFrame);

                const callFrameStartLocation = this.resolveLocation(callFrame, sourceScript, start, scriptLineNumber, scriptColumnNumber);
                if (callFrameStartLocation.scriptOffset !== start) {
                    Object.defineProperty(callFrame, 'start', {
                        value: callFrameStartLocation.scriptOffset
                    });
                }
            }
        }

        return callFrameIndex;
    }
    resolveCallFrame(inputCallFrame: V8CpuProfileCallFrame, scriptsMap: IProfileScriptsMap) {
        return this.callFrames[this.resolveCallFrameIndex(inputCallFrame, scriptsMap)];
    }

    resolveScriptCallFrameIndex(script: CpuProScript) {
        let callFrameIndex = this.#scriptCallFrames.get(script);

        if (callFrameIndex === undefined) {
            callFrameIndex = this.#resolveScriptCallFrameIndex({
                scriptId: -1,
                url: script.url,
                functionName: '',
                lineNumber: 0,
                columnNumber: 0,
                start: 0,
                end: script.source?.length || 0
            }, script);
            this.#scriptCallFrames.set(script, callFrameIndex);
        }

        return callFrameIndex;
    }

    resolveLocationCallFrame(
        script: CpuProScript,
        scriptOffset: number,
        line: number,
        column: number
    ): CpuProCallFrame {
        let candidate: CpuProCallFrame | null = null;

        if (scriptOffset !== -1) {
            const functionRange = getFunctionAtScriptOffset(script, scriptOffset);

            if (functionRange !== null) {
                const lineNumber = functionRange.callFrameStartLine - 1;
                const columnNumber = functionRange.callFrameStartColumn;
                const callFramesByFunctionName = this.#resolveCallFramesByScriptLineColumn(script, lineNumber, columnNumber);
                const firstFunctionName = callFramesByFunctionName.keys().next().value;

                return this.callFrames[this.#resolveScriptCallFrameIndex({
                    scriptId: -1,
                    url: script.url,
                    functionName: callFramesByFunctionName.has(functionRange.name)
                        ? functionRange.name
                        : firstFunctionName || functionRange.name || '',
                    lineNumber,
                    columnNumber,
                    start: functionRange.callFrameStart,
                    end: functionRange.end
                }, script)];
            }

            for (const callFrame of script.callFrames) {
                if (callFrame.start !== -1 && callFrame.end !== -1 && callFrame.start <= scriptOffset && scriptOffset <= callFrame.end) {
                    if (candidate === null || callFrame.end - callFrame.start < candidate.end - candidate.start) {
                        candidate = callFrame;
                    }
                }
            }

            if (candidate !== null) {
                return candidate;
            }
        }

        if (line !== -1 && column !== -1) {
            candidate = script.callFrames.find(callFrame => callFrame.line === line && callFrame.column === column) || null;

            return candidate || this.callFrames[this.#resolveScriptCallFrameIndex({
                scriptId: -1,
                url: script.url,
                functionName: '',
                lineNumber: line,
                columnNumber: column,
                start: 0,
                end: typeof script.source === 'string' ? script.source.length : Math.max(scriptOffset, 0)
            }, script)];
        }

        return this.callFrames[this.resolveScriptCallFrameIndex(script)];
    }

    #addLocation(
        callFrame: CpuProCallFrame,
        script: CpuProScript | null,
        scriptOffset: number,
        line: number,
        column: number
    ) {
        let hasLoc = false;
        const locationIndex = this.locations.length;
        const location: CpuProLocation = {
            id: locationIndex + 1,
            callFrame,
            script,
            scriptOffset,
            line,
            column
        };

        this.locations.push(location);

        if (callFrame === this.#unknownCallFrame && script !== null) {
            Object.defineProperty(location, 'callFrame', {
                get: () => {
                    const callFrame = this.resolveLocationCallFrame(
                        script,
                        scriptOffset,
                        line,
                        column
                    );

                    Object.defineProperty(location, 'callFrame', { value: callFrame });

                    return callFrame;
                }
            });
        }

        if (scriptOffset !== -1 && script !== null) {
            let byOffset = this.#locationsByScriptOffset.get(script);

            if (byOffset === undefined) {
                this.#locationsByScriptOffset.set(script, byOffset = new Map());
            }

            byOffset.set(scriptOffset, locationIndex);
            hasLoc = true;
        }

        if (line !== -1 && column !== -1 && script !== null) {
            let byLine = this.#locationsByScriptLineColumn.get(script);
            if (byLine === undefined) {
                this.#locationsByScriptLineColumn.set(script, byLine = new Map());
            }

            let byColumn = byLine.get(line);
            if (byColumn === undefined) {
                byLine.set(line, byColumn = new Map());
            }

            byColumn.set(column, locationIndex);
            hasLoc = true;
        }

        if (callFrame && !hasLoc) {
            this.#locationsByNoScriptCallFrame.set(callFrame, locationIndex);
        }

        return locationIndex;
    }

    resolveLocationIndex(
        callFrame: CpuProCallFrame | null = null,
        script: CpuProScript | null = null,
        scriptOffset: number = -1,
        line: number = -1,
        column: number = -1,
        correctLineColumn = false
    ) {
        const resolvedScript = script || callFrame?.script || null;
        let locationIndex = -1;

        scriptOffset = normalizeLoc(scriptOffset);
        line = normalizeLoc(line);
        column = line === -1 ? -1 : normalizeLoc(column);

        if (column === -1) {
            line = -1;
        } else if (correctLineColumn && resolvedScript !== null) {
            line -= resolvedScript.lineOffset;
            if (line === 0) {
                column -= resolvedScript.columnOffset;
            }
        }

        if (callFrame && callFrame.script !== resolvedScript) {
            throw new Error('Call frame script does not match provided script');
        }

        if (scriptOffset !== -1 && resolvedScript !== null) {
            locationIndex = this.#locationsByScriptOffset.get(resolvedScript)?.get(scriptOffset) ?? -1;

            // resolve line and column if possible to store the full location (offset, line, column)
            if (locationIndex === -1 && line === -1 && resolvedScript.source !== null) {
                const lineColumn = getScriptLineColumnFromOffset(resolvedScript, scriptOffset);

                if (lineColumn !== null) {
                    line = lineColumn.line;
                    column = lineColumn.column;
                }
            }
        } else if (line !== -1 && resolvedScript !== null) {
            locationIndex = this.#locationsByScriptLineColumn.get(resolvedScript)?.get(line)?.get(column) ?? -1;

            // resolve offset if possible to store the full location (offset, line, column)
            if (locationIndex === -1 && scriptOffset === -1 && resolvedScript.source !== null) {
                scriptOffset = getScriptOffsetFromLineColumn(resolvedScript, line, column) ?? -1;
            }
        } else if (callFrame) {
            locationIndex = this.#locationsByNoScriptCallFrame.get(callFrame) ?? -1;
        } else if (resolvedScript !== null) {
            return this.resolveScriptCallFrameIndex(resolvedScript);
        } else {
            return this.#unknownLocationIndex;
        }

        if (locationIndex === -1) {
            if (!callFrame) {
                callFrame = resolvedScript !== null && (scriptOffset === 0 || (line === 0 && column === 0))
                    ? this.callFrames[this.resolveScriptCallFrameIndex(resolvedScript)]
                    : this.#unknownCallFrame;
            }

            locationIndex = this.#addLocation(
                callFrame,
                resolvedScript,
                scriptOffset,
                line,
                column
            );
        }

        return locationIndex;
    }

    resolveLocation(
        callFrame?: CpuProCallFrame | null,
        script?: CpuProScript | null,
        scriptOffset?: number,
        line?: number,
        column?: number,
        correctLineColumn = false
    ) {
        return this.locations[this.resolveLocationIndex(callFrame, script, scriptOffset, line, column, correctLineColumn)];
    }

    resolveScript(
        scriptsMap: IProfileScriptsMap,
        scriptId: number,
        url: string | null = null,
        source: string | null = null
    ): CpuProScript | null {
        return scriptsMap.resolveScript(scriptId, url, source);
    }

    resolveCategory(packageType: PackageType): CpuProCategory {
        const name = packageType === 'webpack/runtime'
            ? 'script'
            : packageType;
        let category = this.#categoriesMap.get(name);

        if (category === undefined) {
            category = {
                id: this.#categoriesMap.size + 1,
                name
            };

            this.#categoriesMap.set(name, category);
            this.categories.push(category);
        }

        return category;
    }

    resolveOwner(name: string): CpuProOwner {
        let owner = this.#ownersMap.get(name);

        if (owner === undefined) {
            owner = {
                id: this.#ownersMap.size + 1,
                name
            };

            this.#ownersMap.set(name, owner);
            this.owners.push(owner);
        }

        return owner;
    }

    resolvePackage(
        moduleType: ModuleType,
        modulePath: string | null
    ): CpuProPackage {
        const canonicalRef = `${moduleType}/${modulePath}`;
        let pkg = this.#packagesMap.get(canonicalRef);

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
                        } else if (isVsCodeDebug(modulePath)) {
                            type = 'devtools';
                            ref = 'vscode-js-debug';
                            name = ref;
                            path = modulePath.slice(0, modulePath.indexOf(':') + 1);
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
            case 'logging':
            case 'blocking':
                ref = moduleType;
                type = moduleType;
                name = moduleType !== 'gc' ? `(${moduleType})` : '(garbage collector)';
                break;
        }

        pkg = this.#packagesMap.get(ref);

        if (pkg === undefined) {
            pkg = {
                id: this.packages.length + 1,
                type,
                name,
                shortName: name,
                path,
                version,
                registry,
                cdn,
                category: this.resolveCategory(type)
            };

            this.#packagesMap.set(canonicalRef, pkg);
            this.#packagesMap.set(ref, pkg);
            this.packages.push(pkg);
        }

        return pkg;
    }

    #resolveModule(type: ModuleType, name: string | null, path: string | null = null, script: CpuProScript | null = null) {
        const moduleKey = script ?? name as string;
        let module = this.#modulesMap.get(moduleKey);

        if (module === undefined) {
            const pkg = this.resolvePackage(type, path);

            module = {
                id: this.#modulesMap.size + 1, // starts with 1
                type,
                name,
                path,
                script,
                category: pkg.category,
                package: pkg,
                packageRelPath: null,
                owner: pkg.registry
                    ? this.resolveOwner('package: ' + pkg.name)
                    : this.#unknownOwner
            };

            this.#modulesMap.set(moduleKey, module);
            this.modules.push(module);
        }

        return module;
    }

    resolveNoScriptModuleByFunctionName(functionName: string): CpuProModule {
        const wellKnownModuleType = moduleTypeByWellKnownName.get(functionName as WellKnownName) || null;
        let type: ModuleType = 'unknown';
        let name: string = 'unknown';

        if (wellKnownModuleType !== null) {
            type = wellKnownModuleType;
            name = functionName;
        } else {
            if (functionName.startsWith('RegExp: ')) {
                type = 'regexp';
                name = '(regexp)';
            } else {
                type = 'internals';
                name = '(internals)';
            }
        }

        return this.#resolveModule(type, name);
    }

    resolveModuleByScript(
        script: CpuProScript
    ) {
        let url = script.url;
        let type: ModuleType = 'unknown';
        let name: string | null = null;
        let path: string | null = null;

        // Chromium produces call frames with extensions::SafeBuiltins as url for some reasons,
        // ignore such urls - treat as internals
        if (url === 'extensions::SafeBuiltins') {
            url = '';
        }

        if (!url || url.startsWith('evalmachine.')) {
            let anonymousName = this.#anonymousModuleByScriptId.get(script);

            if (anonymousName === undefined) {
                this.#anonymousModuleByScriptId.set(
                    script,
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

                case 'blob':
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

        return this.#resolveModule(type, name, path, script);
    }

    resolveModule(script: CpuProScript | null, functionName: string | null = null) {
        return script === null
            ? this.resolveNoScriptModuleByFunctionName(functionName || '')
            : this.resolveModuleByScript(script);
    }

    // TODO: make a function once drop this.#anonymousFunctionNameIndex as a dependency
    #resolveFunctionName(
        functionName: string,
        lineNumber: number,
        columnNumber: number
    ) {
        let regexp: string | null = null;
        let kind: CpuProCallFrameKind | null = null;
        let name = functionName;

        if (functionName.startsWith('RegExp: ')) {
            regexp = functionName.slice('RegExp: '.length);
            name = regexp.length <= maxRegExpLength
                ? regexp
                : `${regexp.slice(0, maxRegExpLength - 1)}…`;
        } else {
            for (const [prefix, prefixKind] of callFrameKindPrefixes) {
                if (functionName.startsWith(prefix)) {
                    kind = prefixKind;
                    name = functionName.slice(prefix.length);

                    if (kind === 'builtin') {
                        const [, Cls] = name.match(/^((?:Object|Array|Set|WeakSet|Map|WeakMap|WeakRef|Number|Math|String|Boolean|RegExp|Date|Promise|TypedArray|(?:Fast)?Function|Generator|Proxy)(?:Iterator)?)[A-Z]/) || [];


                        if (Cls) {
                            if (Cls === name) {
                                name = Cls;
                            } else {
                                const rest = name.slice(Cls.length);

                                if (rest === 'Constructor') {
                                    name = `new ${Cls}`;
                                } else {
                                    name = Cls + rest
                                        .replace(/^Prototype([A-Z])/, (_, matched) => `#${matched.toLowerCase()}`)
                                        .replace(/^[A-Z]/, (matched) => `.${matched.toLowerCase()}`);
                                }
                            }
                        }
                    }

                    break;
                }
            }

            if (!kind && !name) {
                name = lineNumber === 0 && columnNumber === 0
                    ? '(script)'
                    : `(anonymous function #${this.#anonymousFunctionNameIndex++})`;
            }
        }

        return { name, kind, regexp };
    }
}

function isVsCodeDebug(modulePath: string) {
    return (
        modulePath.includes('bootloader.') &&
        /[\\\/](?:ms-vscode\.js-debug|vscode-js-debug-)/.test(modulePath) &&
        /[\\\/](?:vscode-js-debug-)?bootloader\.(?:bundle\.)?js$/.test(modulePath)
    );
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

function locFromLineColumn(line: number, column: number) {
    return line !== -1 && column !== -1
        ? `:${line}:${column}`
        : null;
}

function normalizeLoc(value: unknown) {
    return typeof value === 'number' && value >= 0 ? value : -1;
}

function resolveCallFrameKind(script: CpuProScript | null, name: string, regexp: string | null): CpuProCallFrameKind {
    if (script === null) {
        if (name === '(root)') {
            return 'root';
        }

        if (name === '(unknown)') {
            return 'unknown';
        }

        if (moduleTypeByWellKnownName.has(name as WellKnownName)) {
            return 'vm-state';
        }
    }

    if (regexp !== null) {
        return 'regexp';
    }

    if (name === '(script)') {
        return 'script';
    }

    return 'function';
}

function setCallFrameLazyStartEndIfNeeded(
    callFrame: CpuProCallFrame,
    lineNumber: number,
    columnNumber: number,
    sourceScript: CpuProScript | null,
    start: number,
    end: number
) {
    if (lineNumber !== -1 && columnNumber !== -1 && sourceScript && typeof sourceScript.source === 'string') {
        if (start === -1) {
            if (callFrame.kind === 'script') {
                callFrame.start = 0;
            } else {
                Object.defineProperty(callFrame, 'start', {
                    get() {
                        const offset = getScriptOffsetFromLineColumn(sourceScript, lineNumber, columnNumber);
                        Object.defineProperty(this, 'start', { value: offset });
                        return offset;
                    }
                });
            }
        }
        if (end === -1) {
            if (callFrame.kind === 'script') {
                callFrame.end = sourceScript.source.length;
            } else {
                Object.defineProperty(callFrame, 'end', {
                    get() {
                        const offset = getFunctionEndFromScriptLineColumn(sourceScript, lineNumber, columnNumber);
                        Object.defineProperty(this, 'end', { value: offset });
                        return offset;
                    }
                });
            }
        }
    }
}
