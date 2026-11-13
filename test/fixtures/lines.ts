import type { Range } from '../../app/prepare/computations/coordinates.js';
import type { ProfileLine, ProfileLineBreakdown } from '../../app/prepare/lines/types.js';
import type { ProfileFixtureOptions } from './profile.js';

// Allocation attributes of `createProfileFixture()`, whose allocation events weigh 16, 32, 48 and 64 bytes:
// events 0 and 2 are alive, event 1 is short-lived and event 3 long-lived; events 0 and 1 are in new space,
// events 2 and 3 in old space
export const allocationAttributes: ProfileFixtureOptions = {
    allocationGc: [0, 1, 0, 2],
    allocationSpaces: [1, 1, 2, 2],
    allocationSpaceNames: { 1: 'new_space', 2: 'old_space' }
};

// Entries of attribute values that are the indices of their dictionary entries
export function dictEntries(dict: unknown[]) {
    return Uint32Array.from(dict, (_, index) => index);
}

// The breakdown of a line by its kind
export function findBreakdown(line: ProfileLine, kind: string) {
    const breakdown = line.breakdowns.find(entry => entry.kind === kind);

    if (breakdown === undefined) {
        throw new Error('No breakdown ' + kind);
    }

    return breakdown;
}

// The context a page gives views and Jora methods for the scope of a breakdown, with a viewport when it's given
export function scopeContext(breakdown: ProfileLineBreakdown, scopeViewport: Range | null = null) {
    return {
        scopeViewport,
        scopeLine: breakdown.line,
        scopeProfile: breakdown.line.profile,
        scopeBreakdown: breakdown
    };
}
