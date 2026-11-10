import { convertToInt32Array } from '../misc/utils.js';

// Samples are remapped in place, since their source ids are not needed afterwards
// and a vector of samples takes hundreds of megabytes on large traces
// FIXME: sampleIdMap can contain -1 for missed IDs; normally, this shouldn't happen,
// but it is possible with corrupted or incomplete input data, so it probably makes sense to handle such cases
export function remapSamples(samples: Uint32Array, sampleIdMap: Int32Array) {
    const tmpMap = new Uint32Array(sampleIdMap.length);
    const samplesMap: number[] = []; // -> callFramesTree.nodes
    let sampledNodesCount = 0;

    // remap samples -> samplesMap, populate samplesMap
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];
        const newSample = tmpMap[id];

        if (newSample === 0) {
            samplesMap.push(sampleIdMap[id]);
            tmpMap[id] = ++sampledNodesCount;
            samples[i] = sampledNodesCount - 1;
        } else {
            samples[i] = newSample - 1;
        }
    }

    // convert to typed array for faster processing
    return {
        samples,
        sampleToNode: convertToInt32Array(samplesMap)
    };
}
