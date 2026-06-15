import type { Ownership } from './formats/types.js';

export function buildOwnershipLookup(
    ownership: Ownership | null | undefined
): (sourcePath: string) => string[] | null {
    if (!ownership || !ownership.files || !ownership.areas) {
        return () => null;
    }

    const { areas, files } = ownership;
    const cache = new Map<string, string[] | null>();

    return (sourcePath: string): string[] | null => {
        if (cache.has(sourcePath)) {
            return cache.get(sourcePath)!;
        }

        const indices = files[sourcePath];
        const resolved = Array.isArray(indices) && indices.length > 0
            ? indices
                .map(idx => areas[idx])
                .filter((name): name is string => typeof name === 'string' && name.length > 0)
            : null;

        const value = resolved && resolved.length > 0 ? resolved : null;
        cache.set(sourcePath, value);
        return value;
    };
}
