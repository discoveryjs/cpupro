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
import { CpuProSession } from './prepare/types.js';
import { createProfileSession } from './prepare/profile-session.mjs';

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
    const profilingDataset = await work('extract profiling data', () =>
        extractAndValidate(input, rejectData)
    );

    //
    // Process profiles
    //
    const sessions: CpuProSession[] = [];
    const profiles: Profile[] = [];
    const availableLineTypes: Set<ProfileLineType> = new Set([]);

    for (let sessionIndex = 0; sessionIndex < profilingDataset.sessions.length; sessionIndex++) {
        const rawSession = profilingDataset.sessions[sessionIndex];
        const dict = new Dictionary();
        const runSessionTask: typeof work = profilingDataset.sessions.length > 1
            ? (name, fn) => work(`Session ${sessionIndex + 1}/${profilingDataset.sessions.length} — ${name}`, fn)
            : work;

        // create session
        const { session, profiles: threadProfiles } = createProfileSession(rawSession, dict);
        sessions.push(session);

        // process session profiles if any
        for (let i = 0; i < threadProfiles.length; i++) {
            // if (i === 0) continue;
            const { thread, profile: profileData } = threadProfiles[i];

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
                work: threadProfiles.length > 1
                    ? (name, fn) => runSessionTask(`Profile ${i + 1}/${threadProfiles.length} — ${name}`, fn)
                    : runSessionTask
            });

            if (profile.name === undefined) {
                profile.name = 'Profile #' + (i + 1);
            }

            // FIXME: locations should be shared
            profile.codesByCallFrame.forEach(markers['call-frame-codes']);

            for (const line of profile.lines) {
                availableLineTypes.add(line.type);
            }

            // assign thread to profile
            profile.thread = thread;
            thread.profiles.push(profile);

            // profiles accross all the dataset
            profiles.push(profile);
            session.profiles.push(profile);

            if (thread.name === 'CrRendererMain') {
                if (session.defaultProfile === null ||
                    (profile.timeline?.axisTotal || 0) > (session.defaultProfile.timeline?.axisTotal || 0)) {
                    session.defaultProfile = profile;
                }
            }
        }

        // choose defaults
        if (session.defaultProfile === null && session.profiles.length > 0) {
            session.defaultProfile = session.profiles[0];
            // session.profiles.reduce(
            //     (res, profile) => res.nodes.length < profile.nodes.length ? profile : res,
            //     session.profiles[0]
            // );
        }

        session.defaultProcess =
            session.defaultProfile?.thread?.process ??
            session.processes[0] ??
            null;

        // init aggregation by profile count here since we need to know the total number of profiles,
        // that can be filtered out on preprocessing
        for (const profile of profiles) {
            profile.timeDeltasByProfile = new Uint32Array(profiles.length);
            profile.sampleCountsByProfile = new Uint32Array(profiles.length);
        }

        // cross-profiles usage
        const callFramesProfilePresence = new Float32Array(dict.callFrames.length);
        await runSessionTask('cross-profile usage', () => {
            computeCrossProfileUsage(profiles, callFramesProfilePresence);
        });

        if (availableLineTypes.has('memline')) {
            await runSessionTask('compute stable memory allocations', () =>
                processCrossProfileAllocations(dict, profiles)
            );
        }

        // process paths
        await runSessionTask('process module paths', () =>
            processPaths(dict.packages, dict.modules)
        );

        // process display names
        await runSessionTask('process display names', () =>
            processDisplayNames(dict.modules)
        );

        // apply object marker
        await runSessionTask('mark objects', () => {
            dict.locations.forEach(markers['call-frame-position']);
            dict.callFrames.forEach(markers['call-frame']);
            dict.modules.forEach(markers.module);
            dict.packages.forEach(markers.package);
            dict.categories.forEach(markers.category);
            dict.scripts.forEach(markers.script);
        });

        dict.locations.forEach(location => location.callFrame);
    }

    const defaultSession = sessions[0] ?? null;
    const defaultProfile = defaultSession?.defaultProfile ?? null;
    const result = {
        sessions,
        defaultSession,
        profiles,
        defaultProfile
    };

    return result;
} satisfies PrepareFunction);
