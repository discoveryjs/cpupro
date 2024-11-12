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

    // cross-profiles usage
    const callFramesProfilePresence = await work('cross-profile usage', () => {
        const callFramesProfilePresence = new Uint8Array(dict.callFrames.length);

        for (const profile of profiles) {
            const samplesCount = profile.callFramesTimings.samplesCount;

            for (let i = 0; i < samplesCount.length; i++) {
                if (samplesCount[i] > 0) {
                    callFramesProfilePresence[i]++;
                }
            }
        }

        for (const profile of profiles) {
            const { samplesCount, selfTimes } = profile.callFramesTimings;
            const timeDeltasByProfile = new Uint32Array(profiles.length);
            const sampleCountsByProfile = new Uint32Array(profiles.length);

            for (let i = 0; i < samplesCount.length; i++) {
                const profilesCount = callFramesProfilePresence[i] - 1;

                timeDeltasByProfile[profilesCount] += selfTimes[i];
                sampleCountsByProfile[profilesCount] += samplesCount[i];
            }

            profile.timeDeltasByProfile = timeDeltasByProfile;
            profile.sampleCountsByProfile = sampleCountsByProfile;
        }

        return callFramesProfilePresence;
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
        callFramesProfilePresence,
        shared: {
            scripts: dict.scripts,
            callFrames: dict.callFrames,
            modules: dict.modules,
            packages: dict.packages,
            categories: dict.categories
        },

        currentProfile,
        profiles
    };

    return result;
} satisfies PrepareFunction);
