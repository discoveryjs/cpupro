import { CpuProModule, CpuProPackage, PackageType } from '../types';

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

function groupByShortestDomain(pkgParts, packages, prefix) {
    const groups = new Map<string, { packages: CpuProPackage[], paths: string[][] }>();

    for (let i = 0; i < pkgParts.length; i++) {
        const parts = pkgParts[i];
        const key = parts.length > 0 ? parts[0] : '';
        const entry = groups.get(key);

        if (entry !== undefined) {
            entry.packages.push(packages[i]);
            entry.paths.push(parts.slice(1));
        } else {
            groups.set(key, {
                packages: [packages[i]],
                paths: [parts.slice(1)]
            });
        }
    }

    const result: [string, CpuProPackage[]][] = [];

    for (const [key, { packages, paths }] of groups) {
        if (prefix && (packages.length === 1 || key === '')) {
            result.push([`${key ? key + '.' : key}${prefix}`, packages]);
        } else {
            const path = `${key}${prefix ? '.' + prefix : prefix}`;
            const res = groupByShortestDomain(paths, packages, path);

            if (res.length === 1 && prefix) {
                result.push([path, packages]);
            } else {
                result.push(...res);
            }
        }
    }

    return result;
}

function shortenHttpPackageNames(packages: CpuProPackage[]) {
    const httpPackages: CpuProPackage[] = [];
    const pkgPaths: string[][] = [];

    for (const pkg of packages) {
        if (pkg.path && /^https?:/.test(pkg.path)) {
            httpPackages.push(pkg);
        }
    }

    for (const pkg of httpPackages) {
        pkgPaths.push(pkg.name.split('.').reverse());
    }

    for (const [shortName, packages] of groupByShortestDomain(pkgPaths, httpPackages, '')) {
        for (const pkg of packages) {
            pkg.shortName = shortName;
        }
    }
}

export function processPaths(
    packages: CpuProPackage[],
    modules: CpuProModule[]
) {
    shortenHttpPackageNames(packages);

    // shorthand paths
    const shortPathPkgTypes: PackageType[] = ['script', 'devtools'];
    const longestCommonModulePath: Record<PackageType, Record<string, string[] | null>> = Object.create(null);

    for (const pkgType of shortPathPkgTypes) {
        longestCommonModulePath[pkgType] = Object.create(null);
    }

    for (const module of modules.values()) {
        // module path processing
        const modulePath = module.path || '';

        if (modulePath) {
            const pkg = module.package;

            if (shortPathPkgTypes.includes(pkg.type) && pkg.path && pkg.path.includes(':') && !/^https?:/.test(pkg.path)) {
                longestCommonModulePath[pkg.type][pkg.path] = getLongestCommonPath(
                    longestCommonModulePath[pkg.type][pkg.path] || null,
                    modulePath
                );
            }
        }
    }

    for (const [pkgType, longestPaths] of Object.entries(longestCommonModulePath)) {
        for (const [pkgPath, longestPath] of Object.entries(longestPaths)) {
            if (longestPath !== null && longestPath.length > 0) {
                const path = longestPath.join('/');

                for (const pkg of packages.values()) {
                    if (pkg.type === pkgType && pkg.path === pkgPath) {
                        pkg.path = path;
                    }
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
