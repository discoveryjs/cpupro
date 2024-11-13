import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { extractAndValidate } from './prepare/index.js';
import { processPaths } from './prepare/preprocessing/paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { Dictionary } from './prepare/dictionary.js';
import { createProfile, Profile } from './prepare/profile.mjs';
import { computeCrossProfileUsage } from './prepare/computations/cross-profile-usage.mjs';

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

    for (let i = 0; i < profileSet.profiles.length; i++) {
        const profileData = profileSet.profiles[i];

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

        // FIXME: callFramePositions should be shared
        profile.callFramePositionsTree?.dictionary.forEach(markers['call-frame-position']);
        profile.codesByCallFrame.forEach(markers['call-frame-codes']);

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
    callFramesProfilePresence.rule = null;
    await work('cross-profile usage', () => {
        computeCrossProfileUsage(profiles, callFramesProfilePresence);
    });

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

    const currentProfile = profiles[profileSet.indexToView || 0] || profiles[0];
    const result = {
        totalTime: profiles.reduce((max, profile) => Math.max(profile.totalTime, max), 0),
        shared: {
            scripts: dict.scripts,
            callFrames: dict.callFrames,
            modules: dict.modules,
            packages: dict.packages,
            categories: dict.categories
        },

        callFramesProfilePresence,
        currentSamplesConvolutionRule: null,

        currentProfile,
        profiles,
        allProfiles: profiles.slice()
    };

    return result;
} satisfies PrepareFunction);
