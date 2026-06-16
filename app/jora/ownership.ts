import type { Ownership } from '../prepare/formats/types.js';

export const methods = {
    lookupAreas(ownership: Ownership | null | undefined, sourcePath: string) {
        if (!ownership?.files || !ownership.areas || typeof sourcePath !== 'string') {
            return null;
        }

        const indices = ownership.files[sourcePath];
        if (!Array.isArray(indices) || indices.length === 0) {
            return null;
        }

        const result = indices
            .map(idx => ownership.areas[idx])
            .filter((name): name is string => typeof name === 'string' && name.length > 0);

        return result.length > 0 ? result : null;
    }
};
