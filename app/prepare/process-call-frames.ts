import { knownChromeExtensions, maxRegExpLength, typeOrder, wellKnownNodeName } from './const';
import {
    CpuProCallFrame,
    CpuProArea,
    CpuProPackage,
    CpuProModule,
    CpuProFunction,
    ModuleType,
    PackageType,
    WellKnownName,
    WellKnownType
} from './types';

type ReferenceArea = {
    ref: string;
    name: string;
};
type ReferencePackage = {
    ref: string;
    type: PackageType;
    name: string;
    path: string | null;
};
type ReferenceModule = {
    ref: string;
    type: ModuleType;
    name: string | null;
    path: string | null;
    wellKnown: WellKnownType | null;
};

function resolveArea(moduleType: string): ReferenceArea {
    const name = moduleType === 'bundle' || moduleType === 'webpack/runtime'
        ? 'script'
        : moduleType;

    return {
        ref: name,
        name
    };
}

function resolvePackage(
    cache: Map<ReferenceModule, ReferencePackage>,
    moduleRef: ReferenceModule
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

    switch (moduleType) {
        case 'script':
        case 'bundle': {
            const modulePath = moduleRef.path || '';

            if (/\/node_modules\//.test(modulePath)) {
                // use a Node.js path convention
                const pathParts = modulePath.split(/\/node_modules\//);
                const pathLastPart = pathParts.pop() || '';
                const npmPackageNameMatch = pathLastPart.match(/(?:@[^/]+\/)?[^/]+/);

                if (npmPackageNameMatch !== null) {
                    const npmPackageName = npmPackageNameMatch[0];
                    const npmPackagePath = [...pathParts, npmPackageName].join('/node_modules/');

                    ref = npmPackagePath;
                    type = 'npm';
                    name = npmPackageName;
                    path = npmPackagePath;
                }
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
            path = moduleRef.path.startsWith('wasm://wasm/')
                ? 'wasm://wasm/'
                : null;

            break;
        }

        case 'chrome-extension': {
            const url = new URL(moduleRef.path || '');

            ref = url.origin;
            type = 'chrome-extension';
            name = knownChromeExtensions.hasOwnProperty(url.host)
                ? knownChromeExtensions[url.host]
                : url.host;
            path = url.origin;

            break;
        }

        case 'root':
        case 'program':
        case 'gc':
        case 'idle':
        case 'internals':
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
        path
    });

    return entry;
}

function resolveModule(
    scriptId: number,
    url: string | null,
    functionName: string,
    anonymousModuleByScriptId: Map<number, string>
): ReferenceModule {
    const entry: Exclude<ReferenceModule, 'package' | 'area'> = {
        ref: url || String(scriptId),
        type: 'unknown',
        name: null,
        path: null,
        wellKnown: (scriptId === 0 && wellKnownNodeName.get(functionName as WellKnownName)) || null
    };

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

            default:
                entry.type = `protocol-${protocol}`;
                entry.name = url;
        }
    }

    return entry;
}

export function processCallFrames(callFrames: CpuProCallFrame[]) {
    const areas = Object.assign(new Map<string, CpuProArea>(), { unknownTypeOrder: typeOrder.unknown });
    const packages = new Map<string, CpuProPackage>();
    const packageRefCache = new Map();
    const modules = new Map<string, CpuProModule>();
    const functions = Object.assign(new Map<string, CpuProFunction>(), { anonymous: 0 });
    const anonymousModuleByScriptId = new Map<number, string>();
    const wellKnownCallFrames: Record<WellKnownType, CpuProCallFrame | null> = {
        root: null,
        program: null,
        idle: null,
        gc: null
    };

    for (const callFrame of callFrames) {
        const { scriptId, functionName, url, lineNumber, columnNumber } = callFrame;
        const moduleRef = resolveModule(scriptId, url, functionName, anonymousModuleByScriptId);

        let callFrameModule = modules.get(moduleRef.ref);

        // module
        if (callFrameModule === undefined) {
            const areaRef = resolveArea(moduleRef.type);
            let moduleArea = areas.get(areaRef.ref);
            const packageRef = resolvePackage(packageRefCache, moduleRef);
            let modulePackage = packages.get(packageRef.ref);

            // create area (cluster) if needed
            if (moduleArea === undefined) {
                areas.set(areaRef.ref, moduleArea = {
                    id: typeOrder[areaRef.name] || areas.unknownTypeOrder++,
                    name: areaRef.name
                });
            }

            // create package if needed
            if (modulePackage === undefined) {
                packages.set(packageRef.ref, modulePackage = {
                    id: packages.size + 1, // starts with 1
                    type: packageRef.type,
                    name: packageRef.name,
                    path: packageRef.path,
                    area: moduleArea,
                    modules: []
                });
            }

            // create module
            modules.set(moduleRef.ref, callFrameModule = {
                id: modules.size + 1, // starts with 1
                type: moduleRef.type,
                name: moduleRef.name,
                path: moduleRef.path,
                area: moduleArea,
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
                area: callFrameModule.area,
                package: callFrameModule.package,
                module: callFrameModule,
                regexp,
                loc: callFrameModule.path ? `${callFrameModule.path}:${lineNumber}:${columnNumber}` : null
            });

            callFrameModule.functions.push(callFrameFunction);
        }

        callFrame.area = callFrameModule.area;
        callFrame.package = callFrameModule.package;
        callFrame.module = callFrameModule;
        callFrame.function = callFrameFunction;
    }

    return {
        areas: [...areas.values()],
        packages: [...packages.values()],
        modules: [...modules.values()],
        functions: [...functions.values()],
        wellKnownCallFrames
    };
}
