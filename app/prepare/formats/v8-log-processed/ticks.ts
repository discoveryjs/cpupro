import { createCallFrame, createLogCallFrames } from './call-frames.js';
import { findPositionsCodeIndex, processCodePositions } from './positions.js';
import { VM_STATE_GC, VM_STATE_IDLE, VM_STATE_OTHER } from './const.js';
import type { CallFrame, CallNode, V8LogProfile } from './types.js';

const parentOffsetBase = 0x0010_0000;
const useMapForChildren = 8;

function createNode(id: number, callFrame: CallFrame, parentScriptOffset = 0): CallNode {
    return {
        id,
        callFrame,
        parentScriptOffset,
        children: []
    };
}

type CallNodeMap = Map<number, CallNode>;

export function processTicks(v8log: V8LogProfile) {
    const {
        callFrames,
        callFrameIndexByVmState,
        callFrameIndexByCode
    } = createLogCallFrames(v8log);
    const callFrameIndexByAddress = new Map<number, number>();
    const callFrameIndexByNode: number[] = [0]; // 0 for rootNode
    const programCallFrameIndex = callFrameIndexByVmState[VM_STATE_OTHER];
    const rootNode = createNode(1, callFrames[0]);
    const nodes: CallNode[] = [rootNode];
    const nodesTransition = new Map<CallNode, CallNodeMap>();
    const maxCodeIndex = v8log.code.length - 1;
    const ticks = v8log.ticks;
    const samples = new Array(ticks.length);
    const timeDeltas = new Array(ticks.length);
    const samplePositions = new Array(ticks.length);
    const positionsByCode = processCodePositions(v8log.code);
    let lastTm = 0;

    // sort ticks by a timestamp
    ticks.sort((a, b) => a.tm - b.tm);

    // replace function index in inline info for a call frame index (first code in function's codes)
    for (const positions of positionsByCode) {
        if (positions === null || !positions.inlined) {
            continue;
        }

        for (let i = 0; i < positions.inlined.length; i += 3) {
            const callFrameIndex = callFrameIndexByCode[v8log.functions[positions.inlined[i]].codes[0]];
            positions.inlined[i] = callFrameIndex as number;

            if (typeof callFrameIndex !== 'number') {
                throw new Error('Can\'t resolve call frame for an inlined function');
            }
        }
    }

    // process ticks
    for (let tickIndex = 0; tickIndex < ticks.length; tickIndex++) {
        const tick = ticks[tickIndex];
        const tickStack = tick.s;
        const tickVmState = tick.vm;
        let vmStateCallFrameIndex = callFrameIndexByVmState[tickVmState];
        let currentNode = rootNode;
        let prevSourceOffset = 0;

        if (tickVmState !== VM_STATE_GC && tickVmState !== VM_STATE_IDLE) {
            for (let i = tickStack.length - 2; i >= 0; i -= 2) {
                const id = tickStack[i];

                if (id === -1) {
                    continue;
                }

                const callFrameIndex = id <= maxCodeIndex
                    // get precomputed call frame for the code
                    ? callFrameIndexByCode[id]
                    // treat unknown ids as a memory address
                    : getCallFrameByAddressIndex(id);

                // skip ignored call frames
                if (callFrameIndex === null) {
                    continue;
                }

                // resolve next node
                currentNode = getNextNode(currentNode, callFrameIndex, prevSourceOffset);

                // find a script positions if possible
                const codePositions = id <= maxCodeIndex
                    ? positionsByCode[id]
                    : null;

                if (codePositions !== null) {
                    const codePositionsIndex = findPositionsCodeIndex(codePositions.positions, tickStack[i + 1]);

                    // store the script offset for next call frame
                    prevSourceOffset = codePositions.positions[codePositionsIndex + 1];

                    // unroll the inlined functions chain when the code contains inlined functions
                    if (codePositions.inlined !== null) {
                        const inlinedIndex = codePositions.positions[codePositionsIndex + 2];

                        if (inlinedIndex !== -1) {
                            currentNode = getNodeFromInline(currentNode, codePositions.inlined, inlinedIndex);
                        }
                    }
                } else {
                    // when positions are not available for the code, store the script offset as zero as a fallback
                    prevSourceOffset = 0;
                }
            }
        }

        if (vmStateCallFrameIndex === null && currentNode === rootNode) {
            // v8 profiler uses (program) in case no stack captured
            // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L174
            vmStateCallFrameIndex = programCallFrameIndex;
        }

        if (vmStateCallFrameIndex !== null) {
            currentNode = getNextNode(currentNode, vmStateCallFrameIndex, prevSourceOffset);
            prevSourceOffset = 0;
        }

        samples[tickIndex] = currentNode.id;
        timeDeltas[tickIndex] = tick.tm - lastTm;
        samplePositions[tickIndex] = prevSourceOffset;

        lastTm = tick.tm;
    }

    return {
        nodes,
        samples,
        timeDeltas,
        samplePositions
    };

    function getCallFrameByAddressIndex(address: number) {
        let callFrameIndex = callFrameIndexByAddress.get(address);

        if (callFrameIndex === undefined) {
            const callFrame = createCallFrame(`0x${address.toString(16)}`);

            callFrameIndex = callFrames.push(callFrame) - 1;
            callFrameIndexByAddress.set(address, callFrameIndex);
        }

        return callFrameIndex;
    }

    function getNextNodeRef(callFrameIndex: number, parentScriptOffset: number) {
        return callFrameIndex + (parentScriptOffset * parentOffsetBase);
    }

    function getNextNode(currentNode: CallNode, callFrameIndex: number, parentScriptOffset: number) {
        const childrenLength = currentNode.children.length;

        if (childrenLength === 0) {
            return createNextNode(currentNode, callFrameIndex, parentScriptOffset);
        }

        if (childrenLength < useMapForChildren) {
            const callFrame = callFrames[callFrameIndex];

            for (const childId of currentNode.children) {
                const child = nodes[childId - 1];

                if (child.callFrame === callFrame && child.parentScriptOffset === parentScriptOffset) {
                    return child;
                }
            }

            return createNextNode(currentNode, callFrameIndex, parentScriptOffset);
        }

        // cast to CallNodeMap because the map is guaranteed to be defined, but TypeScript can't be sure of that
        return (
            (nodesTransition.get(currentNode) as CallNodeMap).get(getNextNodeRef(callFrameIndex, parentScriptOffset)) ||
            createNextNode(currentNode, callFrameIndex, parentScriptOffset)
        );
    }

    function createNextNode(currentNode: CallNode, callFrameIndex: number, parentScriptOffset: number) {
        const nextNode = createNode(nodes.length + 1, callFrames[callFrameIndex], parentScriptOffset);
        const newChildrenLength = currentNode.children.push(nextNode.id);

        nodes.push(nextNode);
        callFrameIndexByNode.push(callFrameIndex);

        if (newChildrenLength >= useMapForChildren) {
            if (newChildrenLength === useMapForChildren) {
                nodesTransition.set(currentNode, new Map(currentNode.children.map(childId => [
                    getNextNodeRef(
                        callFrameIndexByNode[childId - 1],
                        nodes[childId - 1].parentScriptOffset
                    ),
                    nodes[childId - 1]
                ])));
            } else {
                // cast to CallNodeMap because the map is guaranteed to be defined, but TypeScript can't be sure of that
                (nodesTransition.get(currentNode) as CallNodeMap).set(
                    getNextNodeRef(callFrameIndex, parentScriptOffset),
                    nextNode
                );
            }
        }

        return nextNode;
    }

    function getNodeFromInline(currentNode: CallNode, inlined: number[], i: number) {
        const callFrameIndex = inlined[i * 3];
        const codeOffset = inlined[i * 3 + 1];
        const nextInlinedIndex = inlined[i * 3 + 2];
        const fromNode: CallNode = nextInlinedIndex !== -1
            ? getNodeFromInline(currentNode, inlined, nextInlinedIndex)
            : currentNode;
        const nextNode = getNextNode(fromNode, callFrameIndex, codeOffset);

        return nextNode;
    }
}
