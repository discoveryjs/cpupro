import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { extractAndValidate } from './prepare/index.js';
import { processPaths } from './prepare/preprocessing/paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { Dictionary } from './prepare/dictionary.js';
import { createProfile } from './prepare/profile.js';

export default (async function(input: unknown, { rejectData, markers, setWorkTitle }: PrepareContextApi) {
    const work = async function<T>(name: string, fn: () => T): Promise<T> {
        await setWorkTitle(name);
        const startTime = Date.now();

        try {
            return fn();
        } finally {
            TIMINGS && console.info('>', name, Date.now() - startTime);
        }
    };

    //
    // Extract & validate profile data
    //
    const profileSet = await work('extract profile data', () =>
        extractAndValidate(input, rejectData)
    );

    //
    // Create shared dictionary
    //
    const dict = new Dictionary();

    //
    // Process profiles
    //

    const profiles: Awaited<ReturnType<typeof createProfile>>[] = [];

    for (const data of profileSet.profiles) {
        // execution context goes first sice it affects package name
        // FIXME: following profiles could affect previously loaded profiles,
        // it should perform together with path/name processing
        for (const { origin, name } of data._executionContexts || []) {
            dict.setPackageNameForOrigin(new URL(origin).host, name);
        }

        const profile = await createProfile(data, dict, { work });

        // FIXME: callFramePositions should be shared
        profile.callFramePositionsTree?.dictionary.forEach(markers['call-frame-position']);
        profile.scriptFunctions.forEach(markers['script-function']);

        profiles.push(profile);
    }

    const profile = profiles[profileSet.indexToView || 0];

    // process paths
    await work('process module paths', () =>
        processPaths(dict.packages, dict.modules)
    );

    // process display names
    await work('process display names', () =>
        processDisplayNames(dict.modules)
    );

    // apply object marker
    await work('mark objects', () => {
        dict.callFrames.forEach(markers['call-frame']);
        dict.modules.forEach(markers.module);
        dict.packages.forEach(markers.package);
        dict.categories.forEach(markers.category);
        dict.scripts.forEach(markers.script);
    });

    const result = {
        scripts: dict.scripts,
        callFrames: dict.callFrames,
        modules: dict.modules,
        packages: dict.packages,
        categories: dict.categories,

        profiles,

        '--': '--legacy---',

        ...profile
    };

    return result;
} satisfies PrepareFunction);
