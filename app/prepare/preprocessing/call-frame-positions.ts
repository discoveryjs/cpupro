import type { CpuProCallFrame, CpuProCallFramePosition } from '../types.js';
import { createTreeSourceFromParent } from '../computations/build-trees.js';

function positionRef(callFrameIndex: number, scriptOffset: number) {
    return scriptOffset * 0x0100_0000 + callFrameIndex;
}

function positionNodeRef(nodeIndex: number, scriptOffset: number) {
    return scriptOffset * 0x0100_0000 + nodeIndex;
}

export function processCallFramePositions(
    nodeIndexById: Int32Array,
    nodeParent: Uint32Array,
    nodePositions: Int32Array,
    callFrames: CpuProCallFrame[],
    callFrameByNodeIndex: Uint32Array,
    samples: Uint32Array,
    samplePositions: Int32Array | null
) {
    if (samplePositions === null) {
        return { positionsTreeSource: null };
    }

    const positionsMap = new Map<number, number>();
    const positionNodeMap = new Map<number, number>();
    const positions: CpuProCallFramePosition[] = [];
    const nodesPosition = new Uint32Array(nodeParent.length);
    const samplesPositionNodes: number[] = [];
    const samplesPositionParent: number[] = [];

    // -> nodes
    for (let i = 0; i < nodePositions.length; i++) {
        const callFrameIndex = callFrameByNodeIndex[nodeParent[i]];
        const scriptOffset = nodePositions[i];
        const ref = positionRef(callFrameIndex, scriptOffset);
        let positionIndex = positionsMap.get(ref);

        if (positionIndex === undefined) {
            positionsMap.set(ref, positionIndex = positions.push({
                callFrame: callFrames[callFrameIndex],
                scriptOffset
            }) - 1);
        }

        nodesPosition[i] = positionIndex;
    }

    // samplePositions -> callFramePositions + nodes
    if (samplePositions !== null) {
        for (let i = 0; i < samples.length; i++) {
            const nodeIndex = nodeIndexById[samples[i]];
            const callFrameIndex = callFrameByNodeIndex[nodeIndex] || 0;
            const scriptOffset = samplePositions[i];
            const ref = positionRef(callFrameIndex, scriptOffset);
            let positionIndex = positionsMap.get(ref);

            if (positionIndex === undefined) {
                positionsMap.set(ref, positionIndex = positions.push({
                    callFrame: callFrames[callFrameIndex],
                    scriptOffset
                }) - 1);
            }

            const nodeRef = positionNodeRef(nodeIndex, scriptOffset);
            let sampleNodeId = positionNodeMap.get(nodeRef);

            if (sampleNodeId === undefined) {
                sampleNodeId = nodesPosition.length + positionNodeMap.size;
                positionNodeMap.set(nodeRef, sampleNodeId); // -> sourceIdToNode
                samplesPositionNodes.push(positionIndex); // -> nodes
                samplesPositionParent.push(nodeIndex); // -> parent & sourceIdToNode
            }

            samples[i] = sampleNodeId - nodesPosition.length;
        }
    }

    const positionArraysLength = nodesPosition.length + samplesPositionNodes.length;
    const positionNodes = new Uint32Array(positionArraysLength);
    const positionParent = new Uint32Array(positionArraysLength);

    positionNodes.set(nodesPosition);
    positionNodes.set(samplesPositionNodes, nodesPosition.length);
    positionParent.set(nodeParent);
    positionParent.set(samplesPositionParent, nodesPosition.length);

    const sourceIdToNode = new Int32Array(positionNodeMap.values());
    const positionsTreeSource = createTreeSourceFromParent(
        positionParent,
        sourceIdToNode,
        positionNodes,
        positions
    );

    return {
        samplePositions,
        positionsTreeSource
    };
}
