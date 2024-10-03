import { CpuProModule } from '../types.js';

function moduleDisplayName(module: CpuProModule) {
    if (module.name) {
        return;
    }

    switch (module.package.registry) {
        case 'npm':
            module.name = `${module.package.name}/${module.packageRelPath}`;
            return;
    }

    switch (module.package.type) {
        case 'script':
        case 'wasm':
        case 'node':
            module.name = module.packageRelPath;
            break;

        case 'webpack/runtime':
            module.name = module.path;
            break;
    }

}

export function processDisplayNames(
    modules: CpuProModule[]
) {
    for (const module of modules) {
        moduleDisplayName(module);
    }
}
