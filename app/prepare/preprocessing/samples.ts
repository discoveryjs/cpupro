import { convertToInt32Array } from '../misc/utils.js';

// The sampled id of every sample: source ids with samples get sampled ids in the order they are met, and
// sampleToNode maps sampled ids to the nodes of the source ids
// FIXME: sampleIdMap can contain -1 for missed IDs; normally, this shouldn't happen,
// but it is possible with corrupted or incomplete input data, so it probably makes sense to handle such cases
export function remapSamples(sampleSourceIds: Uint32Array, sampleIdMap: Int32Array) {
    const sampledIds = new Uint32Array(sampleSourceIds.length);
    const tmpMap = new Uint32Array(sampleIdMap.length);
    const samplesMap: number[] = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < sampleSourceIds.length; i++) {
        const id = sampleSourceIds[i];
        const newSample = tmpMap[id];

        if (newSample === 0) {
            samplesMap.push(sampleIdMap[id]);
            tmpMap[id] = ++sampledNodesCount;
            sampledIds[i] = sampledNodesCount - 1;
        } else {
            sampledIds[i] = newSample - 1;
        }
    }

    // convert to typed array for faster processing
    return {
        sampledIds,
        sampleToNode: convertToInt32Array(samplesMap)
    };
}
