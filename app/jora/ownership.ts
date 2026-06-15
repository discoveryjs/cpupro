import type { Ownership } from '../prepare/formats/types.js';
import { buildOwnershipLookup } from '../prepare/ownership-lookup.js';

const lookupCache = new WeakMap<Ownership, (sourcePath: string) => string[] | null>();

function getLookup(ownership: Ownership | null | undefined) {
    if (!ownership) {
        return null;
    }

    let lookup = lookupCache.get(ownership);
    if (!lookup) {
        lookup = buildOwnershipLookup(ownership);
        lookupCache.set(ownership, lookup);
    }

    return lookup;
}

export const methods = {
    lookupAreas(ownership: Ownership | null | undefined, sourcePath: string) {
        if (typeof sourcePath !== 'string') {
            return null;
        }

        const lookup = getLookup(ownership);
        return lookup ? lookup(sourcePath) : null;
    }
};
