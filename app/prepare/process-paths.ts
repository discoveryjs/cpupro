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
    const longestCommonModulePath: Record<string, string[] | null> = Object.create(null);

    for (const module of modules.values()) {
        // module path processing
        const modulePath = module.path || '';

        if (modulePath) {
            const pkg = module.package;

            if (pkg.type === 'script' && pkg.path && pkg.path.includes(':') && !/^https?:/.test(pkg.path)) {
                longestCommonModulePath[pkg.path] = getLongestCommonPath(longestCommonModulePath[pkg.path] || null, modulePath);
            }
        }
    }

    for (const [pkgPath, longestPath] of Object.entries(longestCommonModulePath)) {
        if (longestPath !== null && longestPath.length > 0) {
            const path = longestPath.join('/');

            for (const pkg of packages.values()) {
                if (pkg.type === 'script' && pkg.path === pkgPath) {
                    pkg.path = path;
                }
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
