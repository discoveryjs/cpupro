import type { Dictionary } from '../dictionary.js';
import type { V8CpuProfileCallFrame, IScriptMapper } from '../types.js';

export function mapCallFrames(
    dict: Dictionary,
    mapper: IScriptMapper,
    callFrames?: V8CpuProfileCallFrame[] | null
) {
    const map = new Uint32Array(callFrames?.length || 0);

    if (callFrames) {
        for (let i = 0; i < callFrames.length; i++) {
            map[i] = dict.resolveCallFrameIndex(callFrames[i], mapper);
        }

        // FIXME: callFrames from v8 log shouldn't dedup
        if (map.length !== callFrames.length) {
            console.warn('Merged call frames:', callFrames.length - map.length);
        }
    }

    return map;
}
