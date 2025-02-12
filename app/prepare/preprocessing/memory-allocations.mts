import { createTreeSourceFromParent } from '../computations/build-trees.js';
import { computeCrossProfileStableAllocations } from '../computations/cross-profile-allocations.mjs';
import type { Dictionary } from '../dictionary.js';
import type { Profile } from '../profile.mjs';
import { sum } from '../utils.js';

export function processMemoryAllocations(
    allocations: number[],
    samplesInterval?: number
) {
    const deltasSum = sum(allocations);

    // compute samples interval as a median if needed (it might be computed on steps before the processing)
    if (typeof samplesInterval !== 'number') {
        samplesInterval = allocations.slice().sort()[allocations.length >> 1]; // TODO: speedup?
    }

    return {
        startTime: 0,
        startNoSamplesTime: 0,
        endTime: deltasSum,
        endNoSamplesTime: 0,
        totalTime: deltasSum,
        samplesInterval
    };
}

export function processCrossProfileAllocations(dict: Dictionary, profiles: Profile[]) {
    const memoryProfiles = profiles.filter(profile => profile.type === 'memory');
    const uniqueValues = new Set<number>();

    if (memoryProfiles.length === 0) {
        return;
    }

    for (const profile of memoryProfiles) {
        const sampleSizeCounts = Object.create(null);

        for (const size of profile.timeDeltas) {
            uniqueValues.add(size);
            sampleSizeCounts[size] = (sampleSizeCounts[size] || 0) + 1;
        }

        profile._sampleSizeCounts = Object.fromEntries(Object.entries(sampleSizeCounts)
            .sort((a, b) => Number(a[0]) - Number(b[0])));
    }

    const uniqueValuesArray = [...uniqueValues].sort();
    const uniqueValuesMap = new Map(uniqueValuesArray.map((val, index) => [val, index]));
    const uniqueValuesCount = uniqueValuesArray.length;
    const callFramesCount = dict.callFrames.length;
    const callFramesMap = new Map(dict.callFrames.map((callFrame, index) => [callFrame, index]));
    const callFramesStable = new Uint32Array(callFramesCount);
    const samplesStable = new Uint32Array(callFramesCount * uniqueValuesCount);

    const commonTree = buildCommonTree(dict, memoryProfiles);

    for (const profile of memoryProfiles) {
        Object.assign(profile, {
            _commonTree: commonTree,
            _uniqueValuesMap: uniqueValuesMap,
            _uniqueValuesArray: uniqueValuesArray,
            _callFramesMap: callFramesMap,
            _callFramesVariance: new Uint32Array(callFramesCount),
            _callFramesStable: callFramesStable,
            _samplesStable: samplesStable,
            _samplesAll: new Uint32Array(callFramesCount * uniqueValuesCount)
        });
    }

    computeCrossProfileStableAllocations(memoryProfiles);
}

function buildCommonTree(dict: Dictionary, profiles: Profile[]) {
    const dictionary = dict.callFrames;
    const dictSize = dictionary.length;
    const commonNodes = [0];
    const commonNodeByRef = new Map([[0, 0]]);
    const commonParent = [0];
    const nodesToCommonNodes: Uint32Array[] = [];

    for (const profile of profiles) {
        const { callFramesTree: { nodes, parent } } = profile;
        const nodesTo = new Uint32Array(nodes.length);

        nodesToCommonNodes.push(nodesTo);

        for (let i = 1; i < nodes.length; i++) {
            const parentNodeId = nodesTo[parent[i]];
            const ref = parentNodeId * dictSize + nodes[i];
            let nodeId = commonNodeByRef.get(ref);

            if (nodeId === undefined) {
                nodeId = commonNodes.push(nodes[i]) - 1;
                commonParent.push(parentNodeId);
                commonNodeByRef.set(ref, nodeId);
            }

            nodesTo[i] = nodeId;
        }
    }

    const commonNodeMap = Int32Array.from({ length: commonNodes.length }, (_, idx) => idx);
    const source = createTreeSourceFromParent(
        new Uint32Array(commonParent),
        commonNodeMap,
        new Uint32Array(commonNodes),
        dictionary
    );

    // for (let i = 0; i < profiles.length; i++) {
    //     const profile = profiles[i];
    //     const nodeTo = nodesToCommonNodes[i];
    // }

    return source;
}
