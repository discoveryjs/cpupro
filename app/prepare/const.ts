import { ModuleType, PackageType, WellKnownName, WellKnownType } from './types';

// TODO: delete after completing the comparison with the previous version for temporary analysis purposes
export const OLD_COMPUTATIONS = true;
export const TIMINGS = true;
export const USE_WASM = true;

export const EMPTY_ARRAY = Object.freeze([]);
export const maxRegExpLength = 65;
export const wellKnownNodeName = new Map<WellKnownName, WellKnownType>([
    ['(root)', 'root'],
    ['(program)', 'program'],
    ['(garbage collector)', 'gc'],
    ['(idle)', 'idle']
]);
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
export const typeColor: Record<PackageType, string> = {
    'node': '#78b362a0',
    'electron': '#9feaf9a0',
    'script': '#fee29ca0',
    'npm': '#f98e94a0',
    'wasm': '#9481ffa0',
    // 'garbage collector': '#f1b6fda0',
    'gc': '#f1b6fda0',
    'regexp': '#8db2f8a0',
    'internals': '#fcb69aa0',
    'program': '#edfdd1a0',
    'chrome-extension': '#7dfacda0',
    'root': '#444444a0',
    'webpack/runtime': '#888888a0',
    'idle': '#888888a0',
    'unknown': '#888888a0'
};
export const typeColorComponents = Object.fromEntries(Object.entries(typeColor)
    .map(([type, color]) =>[type, [
        parseInt(color.slice(0, 2), 16),
        parseInt(color.slice(2, 4), 16),
        parseInt(color.slice(4, 6), 16)
    ]])
);
export const typeOrder = Object.fromEntries(
    Object.keys(typeColor).map((type, idx) => [type, idx + 1])
) as Record<ModuleType, number>;
