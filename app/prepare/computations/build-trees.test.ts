import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createTreeSourceFromParent } from './build-trees.js';

test('maps source ids of the same node to that node in the computed order', () => {
    // node 0 is the root with children 1 and 2, node 3 is a child of node 1
    const source = createTreeSourceFromParent(
        new Uint32Array([0, 0, 0, 1]),
        new Int32Array([3, 2, 3, -1, 2]),
        new Uint32Array([10, 11, 12, 13]),
        []
    );
    const nodeValue = (node: number) => node !== -1
        ? source.nodes[node]
        : -1;
    const sourceIdNodes = [...source.sourceIdToNode].map(nodeValue);

    assert.deepEqual(sourceIdNodes, [13, 12, 13, -1, 12]);
});
