import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSamplesMask } from './call-tree.js';

test.each([0, 1, 3])('keeps extra mask cells zero without testing them: extraSize=%i', extraSize => {
    const first = { name: 'first' };
    const second = { name: 'second' };
    const treeMetrics = {
        tree: { dictionary: [first, second], nodes: new Uint32Array([1, 0]) },
        sampleToNode: new Uint32Array([0, 1, 0])
    };
    const visited = [];
    const mask = makeSamplesMask(treeMetrics, (entry, sampleId) => {
        visited.push([entry, sampleId]);
        return true;
    }, extraSize);

    assert.deepEqual(visited, [[second, 0], [first, 1], [second, 2]]);
    assert.deepEqual([...mask], [1, 1, 1, ...new Array(extraSize).fill(0)]);
    assert.deepEqual([...makeSamplesMask(treeMetrics, second)], [1, 0, 1]);
    assert.deepEqual([...makeSamplesMask(treeMetrics, first, extraSize)], [0, 1, 0, ...new Array(extraSize).fill(0)]);
    assert.deepEqual([...treeMetrics.sampleToNode], [0, 1, 0]);
});

test('creates an excluded sink cell for an empty sample mapping', () => {
    const mask = makeSamplesMask({
        tree: { dictionary: [], nodes: new Uint32Array() },
        sampleToNode: new Uint32Array()
    }, () => assert.fail('Predicate must not be called for padding'), 1);

    assert.deepEqual([...mask], [0]);
});
