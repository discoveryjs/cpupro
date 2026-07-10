import type { PrepareContextApi, PrepareFunction } from '@discoveryjs/discovery';
import { TIMINGS } from './prepare/const.js';
import { extractAndValidate } from './prepare/index.js';
import { processPaths } from './prepare/preprocessing/short-paths.js';
import { processDisplayNames } from './prepare/preprocessing/module-names.js';
import { Dictionary } from './prepare/dictionary.js';
import { createProfile, Profile } from './prepare/profile.mjs';
import { ProfileLineType } from './prepare/lines/types.js';
import { CpuProSession } from './prepare/types.js';
import { createProfileSession } from './prepare/profile-session.mjs';
import { createWorkHandler } from './prepare/misc/work.js';

const now = typeof performance !== 'undefined' && performance.now
    ? performance.now.bind(performance)
    : Date.now.bind(Date);

function createContextFreeWorkHandler(setWorkTitle) {
    return createWorkHandler(async function<T>(name: string, fn: () => T): Promise<T> {
        const startTime = now();
        await setWorkTitle(name);

        try {
            return await fn();
        } finally {
            TIMINGS && console.info('>', name, (now() - startTime).toFixed(1).replace(/\.0$/, '') + 'ms');
            if (performance && performance.measure) {
                performance.measure(name, { start: startTime });
            }
        }
    });
}

// A quick hack to free memory by breaking the reference to the original input object
function cleanupInput(input: unknown) {
    for (const key of Object.keys(input as Record<string, unknown>)) {
        delete (input as Record<string, unknown>)[key];
    }

    return null;
}

export default (async function(input: unknown, { rejectData, markers, setWorkTitle }: PrepareContextApi) {
    // Create work handler in a separate function to avoid capturing the context
    // of this function and its arguments
    const work = createContextFreeWorkHandler(setWorkTitle);

    //
    // Extract & validate profile data
    //

    const profilingDataset = await work('extract profiling data', () =>
        extractAndValidate(input, rejectData)
    );

    // FIXME: breaks the reference to the original input object, allowing it to be garbage collected;
    // that's a temporary workaround to avoid keeping the entire input in memory while processing the dataset.
    // Setting input to null is not effective because Discovery.js keeps a reference to the input object in upper contexts.
    input = cleanupInput(input);

    //
    // Process profiles
    //
    const sessions: CpuProSession[] = [];
    const profiles: Profile[] = [];
    const availableLineTypes: Set<ProfileLineType> = new Set([]);

    for (let sessionIndex = 0; sessionIndex < profilingDataset.sessions.length; sessionIndex++) {
        const rawSession = profilingDataset.sessions[sessionIndex];
        const dict = new Dictionary();

        // Seed owners from session ownership metadata (if any) so the dictionary
        // contains real area names before modules are resolved. Real per-module
        // attribution is wired separately.
        if (rawSession.ownership) {
            for (const area of rawSession.ownership.areas) {
                dict.resolveOwner(area);
            }
        }

        const runSessionTask: typeof work = profilingDataset.sessions.length > 1
            ? work.withPrefix(`Session ${sessionIndex + 1}/${profilingDataset.sessions.length}`)
            : work;

        // create session
        const { session, profiles: sessionProfiles } = createProfileSession(rawSession, dict);
        sessions.push(session);

        // process session profiles if any
        for (let i = 0; i < sessionProfiles.length; i++) {
            // if (i === 0) continue;
            const { thread, profile: profileData } = sessionProfiles[i];

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

            const profile = await createProfile(profileData, {
                dictionary: dict,
                runtime: null,
                ownership: rawSession.ownership ?? null,
                work: sessionProfiles.length > 1
                    ? runSessionTask.withPrefix(`Profile ${i + 1}/${sessionProfiles.length}`)
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
                    measureWorkTime(profile) > measureWorkTime(session.defaultProfile)) {
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

        // process paths
        await runSessionTask('process module paths', () =>
            processPaths(dict.packages, dict.modules)
        );

        // process display names
        await runSessionTask('process display names', () =>
            processDisplayNames(dict.modules)
        );

        // trigger call frame resolution for all locations
        dict.locations.forEach(location => location.callFrame);

        // apply object marker
        await runSessionTask('mark objects', () => {
            dict.locations.forEach(markers['call-frame-position']);
            dict.callFrames.forEach(markers['call-frame']);
            dict.modules.forEach(markers.module);
            dict.packages.forEach(markers.package);
            dict.categories.forEach(markers.category);
            dict.owners.forEach(markers.owner);
            dict.scripts.forEach(markers.script);
        });
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

function measureWorkTime(profile: Profile) {
    const callStack = profile.timeline?.breakdowns.find(tree => tree.kind === 'call-stack') ?? null;
    const categories = callStack?.categories?.all.dict.entries ?? [];

    return categories.reduce((res, category) => {
        if (!['idle', 'root', 'logging'].includes(category.entry.name)) {
            return res + category.selfValue;
        }

        return res;
    }, 0);
}
