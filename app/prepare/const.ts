import { PackageType, PackageRegistry, WellKnownName, WellKnownType } from './types';

// TODO: delete after completing the comparison with the previous version for temporary analysis purposes
export const OLD_COMPUTATIONS = false;
export const TIMINGS = false;
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
export const knownRegistry: Record<string, PackageRegistry> = {
    'https://jsr.io/': 'jsr',
    'https://deno.land/x/': 'denoland'
};

export const typeColor: Record<PackageType | PackageRegistry, string> = {
    'script': '#fee29ca0',
    'npm': '#f98e94a0',
    'jsr': '#ffee61a0',
    'denoland': '#ffffffa0',
    'wasm': '#9481ffa0',
    'regexp': '#8db2f8a0',
    'electron': '#9feaf9a0',
    'deno': '#ffffffa0', // before node, because uses node modules as well
    'node': '#78b362a0',
    'internals': '#fcb69aa0',
    'program': '#edfdd1a0',
    'chrome-extension': '#7dfacda0',
    'webpack/runtime': '#888888a0',
    'gc': '#f1b6fda0',
    'engine': '#fc9a9aa0',
    'root': '#444444a0',
    'idle': '#888888a0',
    'unknown': '#888888a0'
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
