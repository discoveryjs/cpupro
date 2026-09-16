import type { Profile } from './prepare/profile.mjs';
import { mapLineRanges } from './prepare/computations/line-mapping.js';

export function subscribeSelectionSync(profiles: readonly Profile[], getPeers: (profile: Profile) => Iterable<Profile>) {
    let syncing = false;
    const subscriptions = profiles.flatMap(profile => profile.lines.map(source => source.range.selection.updates.subscribe(() => {
        if (syncing) {
            return;
        }

        const time = source.kind === 'time'
            ? source
            : source.mappings.timeline?.line;

        if (!time) {
            return;
        }

        const ranges = source === time
            ? source.range.selection.ranges
            : mapLineRanges(source, time, source.range.selection.ranges);

        if (ranges === undefined) {
            return;
        }

        try {
            syncing = true;

            for (const peer of getPeers(profile)) {
                for (const target of peer.lines) {
                    if (target === source) {
                        continue;
                    }

                    const targetTime = target.kind === 'time' ? target : target.mappings.timeline?.line;
                    if (!targetTime) {
                        continue;
                    }

                    const translated = target === targetTime ? ranges : mapLineRanges(targetTime, target, ranges);
                    if (translated !== undefined) {
                        target.range.selection.setRanges(translated);
                    }
                }
            }
        } finally {
            syncing = false;
        }
    })));

    return () => subscriptions.forEach(unsubscribe => unsubscribe());
}
