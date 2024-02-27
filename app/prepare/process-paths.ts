import { CpuProFunction, CpuProModule, CpuProPackage } from './types';

function getLongestCommonPath(longestCommonModulePath: string[] | null, modulePath: string) {
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

export function processPaths(
    packages: CpuProPackage[],
    modules: CpuProModule[],
    functions: CpuProFunction[]
) {
    // shorthand paths
    let longestCommonModulePath: string[] | null = null;

    for (const module of modules.values()) {
        // module path processing
        const modulePath = module.path || '';

        if (modulePath) {
            if (module.package.type === 'script' && module.package.path === 'file:') {
                longestCommonModulePath = getLongestCommonPath(longestCommonModulePath, modulePath);
            }
        }
    }

    if (longestCommonModulePath !== null && longestCommonModulePath.length > 0) {
        const path = longestCommonModulePath.join('/');

        for (const pkg of packages.values()) {
            if (pkg.type === 'script' && pkg.path === 'file:') {
                pkg.path = path;
            }
        }

        for (const fn of functions.values()) {
            if (fn.loc && fn.loc.startsWith(path + '/')) {
                fn.loc = './' + fn.loc.slice(path.length + 1);
            }
        }
    }

    for (const module of modules.values()) {
        const modulePath = module.path || '';

        if (module.package.path && modulePath.startsWith(module.package.path)) {
            module.packageRelPath = modulePath
                .slice(module.package.path.length)
                .replace(/^[\/\\]+/, '');
        }
    }
}
