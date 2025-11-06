import type { Profile } from '../profile.mjs';

export function computeCrossProfileUsage(profiles: Profile[], callFramesProfilePresence: Float32Array) {
    callFramesProfilePresence.fill(0);

    for (const profile of profiles) {
        const callFramesMetrics = profile.primaryLine?.dict.callFrames?.all;

        if (!callFramesMetrics) {
            continue;
        }

        const samplesCount = callFramesMetrics.samplesCount;

        for (let i = 0; i < samplesCount.length; i++) {
            if (samplesCount[i] > 0) {
                callFramesProfilePresence[i]++;
            }
        }
    }

    for (const profile of profiles) {
        const { timeDeltasByProfile, sampleCountsByProfile} = profile;
        const callFramesMetrics = profile.primaryLine?.dict.callFrames?.all;

        if (!callFramesMetrics) {
            continue;
        }

        const { samplesCount, selfValues } = callFramesMetrics;

        timeDeltasByProfile.fill(0);
        sampleCountsByProfile.fill(0);

        for (let i = 0; i < samplesCount.length; i++) {
            const profilesCount = callFramesProfilePresence[i] - 1;

            timeDeltasByProfile[profilesCount] += selfValues[i];
            sampleCountsByProfile[profilesCount] += samplesCount[i];
        }
    }

    for (let i = 0; i < callFramesProfilePresence.length; i++) {
        callFramesProfilePresence[i] /= profiles.length;
    }
}
