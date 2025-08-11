import type { CallNode, CodePositionTable, V8LogTick } from './types.js';
import { findPositionsCodeIndex } from './positions.js';
import { VM_STATE_GC, VM_STATE_IDLE } from './const.js';

const parentOffsetBase = 0x0010_0000;
const useMapForChildren = 8;

function createNode<T>(id: number, callFrame: T, parentScriptOffset = 0): CallNode<T> {
    return {
        id,
        callFrame,
        parentScriptOffset,
        children: []
    };
}

function ensureSortedTicks(v8logTicks: V8LogTick[]) {
    if (v8logTicks.length > 1) {
        // check ticks are sorted by tm
        for (let i = 1, prevTm = v8logTicks[0].tm; i < v8logTicks.length; i++) {
            const { tm } = v8logTicks[i];

            if (prevTm > tm) {
                // make a copy before sorting to avoid mutation of input data
                // TODO: replace slice().sort() with toSorted()
                return v8logTicks.slice().sort((a, b) => a.tm - b.tm);
            }

            prevTm = tm;
        }
    }

    return v8logTicks;
}

type CallNodeMap = Map<number, CallNode<number>>;

export function processTicks(
    v8logTicks: V8LogTick[],
    callFrameIndexByVmState: number[] | Uint32Array,
    callFrameIndexByCode: number[] | Uint32Array,
    positionTableByCode: (CodePositionTable | null)[]
) {
    const programCallFrameIndex = callFrameIndexByVmState[VM_STATE_IDLE];
    const maxCodeCallFrameIndex = callFrameIndexByCode.length - 1;
    const rootNode = createNode(1, 0);
    const nodes: CallNode<number>[] = [rootNode];
    const nodeTransitionMaps = new Map<CallNode<number>, CallNodeMap>();
    const samples: number[] = new Array(v8logTicks.length);
    const timeDeltas: number[] = new Array(v8logTicks.length);
    const samplePositions: number[] = new Array(v8logTicks.length);
    const sortedTicks = ensureSortedTicks(v8logTicks); // ensure ticks are sorted by a timestamp
    let lastTm = 0;

    // process ticks
    for (let tickIndex = 0; tickIndex < sortedTicks.length; tickIndex++) {
        const tick = sortedTicks[tickIndex];
        const tickStack = tick.s;
        const tickVmState = tick.vm;
        let vmStateCallFrameIndex = callFrameIndexByVmState[tickVmState];
        let currentNode = rootNode;
        let prevSourceOffset = -1;

        if (tickVmState !== VM_STATE_GC && tickVmState !== VM_STATE_IDLE) {
            for (let i = tickStack.length - 2; i >= 0; i -= 2) {
                const codeIndex = tickStack[i];

                if (codeIndex < 0 || codeIndex > maxCodeCallFrameIndex) {
                    continue;
                }

                // get precomputed call frame for the code
                const callFrameIndex = callFrameIndexByCode[codeIndex];

                // skip ignored call frames
                if (callFrameIndex === 0) {
                    continue;
                }

                // resolve next node
                currentNode = getNextNode(currentNode, callFrameIndex, prevSourceOffset);

                // find a script positions if possible
                const codePositions = positionTableByCode[codeIndex];

                if (codePositions !== null) {
                    const pc = tickStack[i + 1];
                    const codePositionsIndex = findPositionsCodeIndex(
                        codePositions.positions,
                        // Machine code functions on the stack
                        // that are not currently executing store pc
                        // on the next instruction after the callee is called,
                        // so subtract one from the position
                        pc - (i > 0 && codePositions.pcOnNextInstruction ? 1 : 0)
                    );

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
                    // when positions are not available for the code, store the script offset as -1 as a fallback
                    prevSourceOffset = -1;
                }
            }
        }

        if (vmStateCallFrameIndex === 0 && currentNode === rootNode) {
            // v8 profiler uses (program) in case no stack captured
            // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L174
            vmStateCallFrameIndex = programCallFrameIndex;
        }

        if (vmStateCallFrameIndex !== 0) {
            currentNode = getNextNode(currentNode, vmStateCallFrameIndex, prevSourceOffset);
            prevSourceOffset = -1;
        }

        samples[tickIndex] = currentNode.id;
        timeDeltas[tickIndex] = tick.tm - lastTm;
        samplePositions[tickIndex] = prevSourceOffset;

        lastTm = tick.tm;
    }

    return {
        firstTimestamp: sortedTicks[0].tm,
        lastTimestamp: lastTm,
        nodes,
        samples,
        timeDeltas,
        samplePositions
    };

    function getNextNodeRef(callFrameIndex: number, parentScriptOffset: number) {
        return callFrameIndex + (parentScriptOffset * parentOffsetBase);
    }

    function getNextNode(currentNode: CallNode<number>, callFrameIndex: number, parentScriptOffset: number) {
        const childrenLength = currentNode.children.length;

        if (childrenLength === 0) {
            return createNextNode(currentNode, callFrameIndex, parentScriptOffset);
        }

        if (childrenLength < useMapForChildren) {
            for (const childId of currentNode.children) {
                const child = nodes[childId - 1];

                if (child.callFrame === callFrameIndex && child.parentScriptOffset === parentScriptOffset) {
                    return child;
                }
            }

            return createNextNode(currentNode, callFrameIndex, parentScriptOffset);
        }

        // cast to CallNodeMap because the map is guaranteed to be defined, but TypeScript can't be sure of that
        return (
            (nodeTransitionMaps.get(currentNode) as CallNodeMap).get(getNextNodeRef(callFrameIndex, parentScriptOffset)) ||
            createNextNode(currentNode, callFrameIndex, parentScriptOffset)
        );
    }

    function createNextNode(currentNode: CallNode<number>, callFrameIndex: number, parentScriptOffset: number) {
        const nextNode = createNode(nodes.length + 1, callFrameIndex, parentScriptOffset);
        const newChildrenLength = currentNode.children.push(nextNode.id);

        nodes.push(nextNode);

        if (newChildrenLength >= useMapForChildren) {
            if (newChildrenLength === useMapForChildren) {
                nodeTransitionMaps.set(currentNode, new Map(currentNode.children.map(childId => {
                    const childNode = nodes[childId - 1];

                    return [
                        getNextNodeRef(childNode.callFrame, childNode.parentScriptOffset),
                        childNode
                    ];
                })));
            } else {
                // cast to CallNodeMap because the map is guaranteed to be defined, but TypeScript can't be sure of that
                (nodeTransitionMaps.get(currentNode) as CallNodeMap).set(
                    getNextNodeRef(callFrameIndex, parentScriptOffset),
                    nextNode
                );
            }
        }

        return nextNode;
    }

    function getNodeFromInline(currentNode: CallNode<number>, inlined: number[], i: number) {
        const callFrameIndex = inlined[i * 3];
        const codeOffset = inlined[i * 3 + 1];
        const nextInlinedIndex = inlined[i * 3 + 2];
        const fromNode: CallNode<number> = nextInlinedIndex !== -1
            ? getNodeFromInline(currentNode, inlined, nextInlinedIndex)
            : currentNode;

        return getNextNode(fromNode, callFrameIndex, codeOffset);
    }
}
