import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { extractAndValidate } from './prepare/index.js';
import { processPaths } from './prepare/preprocessing/short-paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { Dictionary } from './prepare/dictionary.js';
import { createProfile, Profile } from './prepare/profile.mjs';
import { computeCrossProfileUsage } from './prepare/computations/cross-profile-usage.mjs';
import { processCrossProfileAllocations } from './prepare/preprocessing/memory-allocations.mjs';
import { ProfileLineType } from './prepare/lines/types.js';

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
    const profiles: Profile[] = [];
    const availableLineTypes: Set<ProfileLineType> = new Set([]);

    for (let i = 0; i < profileSet.profiles.length; i++) {
        // if (i === 0) continue;
        const profileData = profileSet.profiles[i];

        if (!profileData.nodes?.length) {
            console.warn('Ignored a profile with no call tree nodes', profileData);
            continue;
        }

        // execution context goes first sice it affects package name
        // FIXME: following profiles could affect previously loaded profiles,
        // it should perform together with path/name processing
        for (const { origin, name } of profileData._executionContexts || []) {
            dict.setPackageNameForOrigin(new URL(origin).host, name);
        }

        const profile = await createProfile(profileData, dict, {
            work: profileSet.profiles.length > 1
                ? (name, fn) => work(`Profile ${i + 1}/${profileSet.profiles.length} — ${name}`, fn)
                : work
        });

        if (profile.name === undefined) {
            profile.name = 'Profile #' + (i + 1);
        }

        // FIXME: locations should be shared
        profile.locationsTree?.dictionary.forEach(markers['call-frame-position']);
        profile.codesByCallFrame.forEach(markers['call-frame-codes']);

        for (const line of profile.lines) {
            availableLineTypes.add(line.type);
        }

        profiles.push(profile);
    }

    // init aggregation by profile count here since we need to know the total number of profiles,
    // that can be filtered out on preprocessing
    for (const profile of profiles) {
        profile.timeDeltasByProfile = new Uint32Array(profiles.length);
        profile.sampleCountsByProfile = new Uint32Array(profiles.length);
    }

    // cross-profiles usage
    const callFramesProfilePresence = new Float32Array(dict.callFrames.length);
    await work('cross-profile usage', () => {
        computeCrossProfileUsage(profiles, callFramesProfilePresence);
    });

    if (availableLineTypes.has('memline')) {
        await work('compute stable memory allocations', () =>
            processCrossProfileAllocations(dict, profiles)
        );
    }

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

    const primaryProfile = profiles[profileSet.indexToView || 0] || profiles[0];
    const result = {
        shared: {
            scripts: dict.scripts,
            callFrames: dict.callFrames,
            modules: dict.modules,
            packages: dict.packages,
            categories: dict.categories
        },

        callFramesProfilePresence,

        defaultProfile: primaryProfile,
        defaultLineType: primaryProfile.defaultLineType || null,
        availableLineTypes: Array.from(availableLineTypes),

        profiles
    };

    return result;
} satisfies PrepareFunction);
