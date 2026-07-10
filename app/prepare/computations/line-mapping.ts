import { ProfileLine, ProfileLineMapping } from '../lines/types';

export function createLineMapping(
    sourceLine: ProfileLine,
    sourceIds: number[],
    destLine: ProfileLine,
    destIds: number[]
): {
    left: ProfileLineMapping,
    right: ProfileLineMapping
} {
    const sourceToDest = new Uint32Array(sourceIds); // [0, 1, 2, 3, 4, ...]
    const destToSource = new Uint32Array(destIds);
    // [0, 0, 1, 1, 1, 3, 3, ...] -> timeline sample ids
    // we attach memline sample id to the cpu sample id it was recorded after

    const lastDestIndex = destToSource.length - 1;
    for (let i = 0, k = 0; i < sourceToDest.length; i++) {
        const allocId = sourceToDest[i];
        let lastSeenDestId = destToSource[k];

        while (k < lastDestIndex && allocId > lastSeenDestId) {
            lastSeenDestId = destToSource[++k];
        }

        sourceToDest[i] = k;
    }

    const source = {
        line: destLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: sourceToDest
    };
    const dest = {
        line: sourceLine,
        inverse: null as unknown as ProfileLineMapping,
        _mapping: destToSource
    };

    source.inverse = dest;
    dest.inverse = source;

    return {
        left: source,
        right: dest
    };
}
