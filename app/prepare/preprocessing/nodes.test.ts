import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createNodeIndexById, createNodeParent } from './nodes.js';
import type { V8CpuProfileNode } from '../types.js';

test('a node\'s own parent takes precedence over the children of a later node listing it', () => {
    const callFrame = { scriptId: 0, url: '', functionName: '', lineNumber: -1, columnNumber: -1 };
    const nodes: V8CpuProfileNode[] = [
        { id: 1, callFrame, children: [2, 3] },
        { id: 2, callFrame, parent: 1 },
        { id: 3, callFrame, children: [2] }
    ];

    assert.deepEqual([...createNodeParent(nodes, createNodeIndexById(nodes))], [0, 0, 0]);
});
