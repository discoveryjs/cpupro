import { PackageType, PackageRegistry, WellKnownName, WellKnownType, PackageProvider, V8FunctionCodeType, CpuProFunctionCodes, ModuleType } from './types';
import { packageRegistryEndpoints } from './utils';

export const TIMINGS = false;
export const USE_WASM = true;
export const FEATURE_SOURCES = false;
export const FEATURE_MULTI_PROFILES = true;

export const EMPTY_ARRAY = Object.freeze([]);
export const maxRegExpLength = 65;
export const wellKnownCallFrameName = new Map<WellKnownName, WellKnownType>([
    ['(root)', 'root'],
    ['(program)', 'program'],
    ['(garbage collector)', 'gc'],
    ['(idle)', 'idle'],
    ['(no samples)', 'no-samples'],
    ['(parser)', 'parser'],
    ['(bytecode compiler)', 'bytecode-compiler'],
    ['(compiler)', 'compiler'],
    ['(atomics wait)', 'atomics-wait']
]);
export const moduleTypeByWellKnownName = new Map<WellKnownName, ModuleType>([
    ['(root)', 'root'],
    ['(program)', 'program'],
    ['(garbage collector)', 'gc'],
    ['(idle)', 'idle'],
    ['(no samples)', 'unknown'],
    ['(parser)', 'compilation'],
    ['(bytecode compiler)', 'compilation'],
    ['(compiler)', 'compilation'],
    ['(atomics wait)', 'blocking']
]);
export const categories: Exclude<PackageType, 'webpack/runtime'>[] = [
    'script',
    'wasm',
    'regexp',
    'electron',
    'deno',
    'node',
    'internals',
    'program',
    'devtools',
    'chrome-extension',
    'gc',
    'compilation',
    'blocking',
    'root',
    'idle',
    'unknown'
] as const;
export const vmFunctionStateTiers: V8FunctionCodeType[] = [
    'Unknown',
    'Ignition',
    'Sparkplug',
    'Maglev',
    'Turboprop', // Removed in 2022 https://issues.chromium.org/issues/42202499
    'Turbofan'
] as const;
export const vmFunctionStateTierHotness: Record<V8FunctionCodeType, CpuProFunctionCodes['hotness']> = {
    'Unknown': 'cold',
    'Ignition': 'cold',
    'Sparkplug': 'warm',
    'Maglev': 'hot',
    'Turboprop': 'hot',
    'Turbofan': 'hot'
} as const;

export const knownChromeExtensions = {
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

export const knownRegistry: Record<string, PackageProvider> = {
    'https://jsr.io': { cdn: 'jsr', endpoints: packageRegistryEndpoints(
        { registry: 'jsr', pattern: '[atpkg][/version][path]' }
    ) },
    'https://npm.jsr.io': { cdn: 'jsr', endpoints: packageRegistryEndpoints('npm') },
    'https://deno.land': { cdn: 'denoland', endpoints: packageRegistryEndpoints(
        { registry: 'denoland', pattern: '(?<pkg>std)[version][path]' },
        { registry: 'denoland', pattern: 'x/[specifier]' }
    ) },
    'https://esm.sh': { cdn: 'esmsh', endpoints: packageRegistryEndpoints(
        { registry: 'github', pattern: 'v\\d+/gh/[pkg][version][path]' },
        { registry: 'npm', pattern: 'v\\d+/[specifier]' }
    ) },
    'https://cdn.jsdelivr.net': { cdn: 'jsdelivr', endpoints: packageRegistryEndpoints(
        { registry: 'npm', pattern: 'npm/[specifier]' },
        { registry: 'github', pattern: 'gh/[pkg][version][path]' }
    ) },
    'https://unpkg.com': { cdn: 'unpkg', endpoints: packageRegistryEndpoints('npm') },
    'https://esm.run': { cdn: 'jsdelivr', endpoints: packageRegistryEndpoints('npm') },
    'https://ga.jspm.io': { cdn: 'jspm', endpoints: packageRegistryEndpoints(
        { registry: 'npm', pattern: 'npm:[specifier]' }
    ) },
    'https://cdn.skypack.dev': { cdn: 'skypack', endpoints: packageRegistryEndpoints(
        { registry: 'npm', pattern: '-/[pkg][version]-[^\\/\\-]+?/[^\\/]+?,mode=(?<path>.+)' },
        'npm'
    ) }
};

export const allocTimespan = [
    'alive',
    'short-lived',
    'long-lived'
] as const;
export const allocTypes = [
    'hidden',
    'array',
    'string',
    'object',
    'code',
    'closure',
    'regexp',
    'heap-number',
    'native',
    'synthetic',
    'concat-string',
    'sliced-string',
    'symbol',
    'bigint',
    'object-shape',
    'wasm-object'
] as const;
type AllocationTimespan = (typeof allocTimespan)[number];
type AllocationType = (typeof allocTypes)[number];

// colors in order of apperiance in a list
export const typeColor: Record<PackageType | PackageRegistry | V8FunctionCodeType | AllocationType | AllocationTimespan, string> = {
    // FIXME: place part of alloc types here, because regexp alloc type clash with package type
    'object-shape': '#ffffffa0',
    'object': '#fee29ca0',
    'array': '#ffee61a0',
    'string': '#78b362a0',
    'concat-string': '#78b362a0',
    'sliced-string': '#78b362a0',
    // ----

    'script': '#fee29ca0',
    'npm': '#f98e94a0',
    'github': '#666666a0',
    'jsr': '#ffee61a0',
    'denoland': '#ffffffa0',
    'wasm': '#9481ffa0',
    'regexp': '#8db2f8a0',
    'electron': '#9feaf9a0',
    'deno': '#ffffffa0', // before node, because uses node modules as well
    'node': '#78b362a0',
    'internals': '#fcb69aa0',
    'program': '#edfdd1a0',
    'devtools': '#90d7f3a0',
    'chrome-extension': '#7dfacda0',
    'webpack/runtime': '#888888a0',
    'gc': '#f1b6fda0',
    'compilation': '#fc9a9aa0',
    'blocking': '#f2a376a0',
    'root': '#444444a0',
    'idle': '#888888a0',
    'unknown': '#888888a0',

    // compiler tier
    'Unknown': '#888888a0',
    'Ignition': '#b9b9b9a0',
    'Sparkplug': '#e3c685a0',
    'Maglev': '#dba543a0',
    'Turboprop': '#dba543a0',
    'Turbofan': '#f78080a0',

    // alloc types
    // 'regexp': '#8db2f8a0',
    'heap-number': '#65b4fda0',
    'bigint': '#65b4fda0',
    'closure': '#f2a376a0',
    'code': '#fc9a9aa0',
    'symbol': '#ffee61a0',
    'wasm-object': '#9481ffa0',
    'native': '#fcb69aa0',
    'synthetic': '#fcb69aa0',
    'hidden': '#888888a0',

    // alloc timespan
    'alive': '#78b362a0',
    'long-lived': '#f2a376a0',
    'short-lived': '#fee29ca0'
};
export const typeColorComponents = Object.fromEntries(Object.entries(typeColor)
    .map(([type, color]) =>[type, [
        parseInt(color.slice(1, 3), 16),
        parseInt(color.slice(3, 5), 16),
        parseInt(color.slice(5, 7), 16)
    ]])
);
export const typeOrder = Object.fromEntries(
    Object.keys(typeColor).map((type, idx) => [type, idx + 1])
) as Record<PackageType, number>;
