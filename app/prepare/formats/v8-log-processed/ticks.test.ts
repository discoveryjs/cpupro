import assert from 'node:assert/strict';
import { test } from 'vitest';
import { processTicks } from './ticks.js';
import { VM_STATE_JS, VM_STATE_OTHER } from './const.js';
import type { V8LogTick } from './types.js';

test('builds a call tree whose nodes list their children in the order of first ticks', () => {
    // code 1 is "a", code 2 is "b", codes 3-12 are "c0"-"c9"; a stack lists the callee first
    const callFrameIndexByCode = [0, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
    const callFrameIndexByVmState: number[] = [];
    const positionTableByCode = new Array(callFrameIndexByCode.length).fill(null);
    const ticks: V8LogTick[] = [
        { tm: 1, vm: VM_STATE_JS, s: [1, 0] },
        { tm: 2, vm: VM_STATE_JS, s: [2, 0, 1, 0] }
    ];

    callFrameIndexByVmState[VM_STATE_JS] = 0;
    callFrameIndexByVmState[VM_STATE_OTHER] = 100;

    // "a" gets more children than are looked up by a scan, then an existing child is ticked again
    for (let i = 3; i <= 12; i++) {
        ticks.push({ tm: ticks.length + 1, vm: VM_STATE_JS, s: [i, 0, 1, 0] });
    }

    ticks.push({ tm: ticks.length + 1, vm: VM_STATE_JS, s: [12, 0, 1, 0] });

    const { nodes, samples } = processTicks(ticks, callFrameIndexByVmState, callFrameIndexByCode, positionTableByCode);
    const children: number[][] = [];
    const callFrames: number[] = [];

    for (let i = 0; i < nodes.length; i++) {
        children.push(nodes[i].children);
        callFrames.push(nodes[i].callFrame);
    }

    assert.deepEqual(callFrames, [0, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    assert.deepEqual(children, [
        [2],
        [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        [], [], [], [], [], [], [], [], [], [], []
    ]);
    assert.deepEqual(samples, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13]);
});
