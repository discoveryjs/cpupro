import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CallTree } from '../prepare/computations/call-tree.js';
import { TreeMetrics } from '../prepare/computations/metrics.js';
import { subtreeFromParent, nestedFromNodesSubtree } from '../prepare/computations/build-trees.js';
import { makeDictMask, makeSamplesMask, methods } from './call-tree.js';

// Nodes: 0 root, 1 a, 2 b (in a), 3 a (in b, recursive), 4 c; samples are on nodes 1, 2, 3, 4, 2, 0
function createMetrics() {
    const dictionary = ['root', 'a', 'b', 'c'];
    const nodes = new Uint32Array([0, 1, 2, 1, 3]);
    const parent = new Uint32Array([0, 0, 1, 2, 0]);
    const subtree = subtreeFromParent(parent);
    const nested = nestedFromNodesSubtree(nodes, subtree, dictionary.length);
    const tree = new CallTree(dictionary, nodes, parent, subtree, nested);

    const sampleToNode = new Uint32Array([1, 2, 3, 4, 2, 0]);
    const treeMap = {
        tree,
        sampleToNode,
        samplesCount: new Uint32Array([1, 1, 2, 1, 1]),
        selfValues: new Float64Array([10, 20, 30, 40, 50]),
        nestedValues: new Float64Array([140, 70, 40, 0, 0])
    };

    return new TreeMetrics(tree, sampleToNode, () => treeMap);
}

test.each([0, 1, 3])('keeps extra mask cells zero without testing them: extraSize=%i', extraSize => {
    const first = { name: 'first' };
    const second = { name: 'second' };
    const treeMetrics = {
        tree: { dictionary: [first, second], nodes: new Uint32Array([1, 0]) },
        sampleToNode: new Uint32Array([0, 1, 0])
    };
    const visited = [];
    const acceptVisited = (entry, sampleId) => {
        visited.push([entry, sampleId]);
        return true;
    };
    const mask = makeSamplesMask(treeMetrics, acceptVisited, extraSize);

    assert.deepEqual(visited, [[second, 0], [first, 1], [second, 2]]);
    assert.deepEqual([...mask], [1, 1, 1, ...new Array(extraSize).fill(0)]);
    assert.deepEqual([...makeSamplesMask(treeMetrics, second)], [1, 0, 1]);
    assert.deepEqual([...makeSamplesMask(treeMetrics, first, extraSize)], [0, 1, 0, ...new Array(extraSize).fill(0)]);
    assert.deepEqual([...treeMetrics.sampleToNode], [0, 1, 0]);
});

test('creates an excluded sink cell for an empty sample mapping', () => {
    const treeMetrics = {
        tree: { dictionary: [], nodes: new Uint32Array() },
        sampleToNode: new Uint32Array()
    };
    const mask = makeSamplesMask(treeMetrics, () => assert.fail('Predicate must not be called for padding'), 1);

    assert.deepEqual([...mask], [0]);
});

test('tree() nests values under valid parent indices and leaves others at the root', () => {
    // Parent indices: none, 0, 0, 1, out of range, not an integer
    const values = [-1, 0, 0, 1, 6, 1.5];
    const items = values.map((parent, i) => ({ index: i, parent }));
    const getParent = item => item.parent;
    const getIndex = item => item.index;
    const roots = methods.tree(items, getParent, getIndex);
    const describe = node => [
        node.value,
        node.parent === null ? null : node.parent.value,
        node.children.map(describe)
    ];

    assert.deepEqual(roots.map(describe), [
        [0, null, [[1, 0, [[3, 1, []]]], [2, 0, []]]],
        [4, null, []],
        [5, null, []]
    ]);
});

test.each([
    ['nodes', ['a'], [1]],
    ['nodes', [entry => entry === 'b' || entry === 'c'], [2, 4]],
    ['children', [0], [1, 4]],
    ['subtree', [1], [2, 3]],
    ['parent', [3], [2]],
    ['ancestors', [3], [2, 1, 0]]
])('select(%s, %o) gives nodes %o', (type, args, expected) => {
    const { tree } = createMetrics();

    assert.deepEqual(methods.select(tree, type, ...args).map(node => node.nodeIndex), expected);
});

test('select() over metrics gives metrics of the nodes, other types give nothing', () => {
    const metrics = createMetrics();
    const describe = item => {
        const { node, ...values } = item;

        return [node.nodeIndex, values];
    };

    assert.deepEqual(methods.select(metrics, 'children', 0).map(describe), [
        [1, { selfValue: 20, nestedValue: 70, totalValue: 90 }],
        [4, { selfValue: 50, nestedValue: 0, totalValue: 50 }]
    ]);
    assert.equal(methods.select(metrics, 'siblings', 0), undefined);
});

test('selectBy() and makeDictMask() take an entry or a test of entries', () => {
    const { tree } = createMetrics();

    assert.deepEqual(methods.selectBy(tree, 'a').map(node => node.nodeIndex), [1, 3]);
    assert.deepEqual([...makeDictMask(tree, 'b')], [0, 0, 1, 0]);
    assert.deepEqual([...makeDictMask(tree, entry => entry !== 'root')], [0, 1, 1, 1]);
});

test.each([
    { includeSelf: false, entries: ['b'], samples: [1, 4] },
    { includeSelf: true, entries: ['b', 'a'], samples: [0, 1, 2, 4] }
])('subtreeSamples() of a with includeSelf=$includeSelf selects samples $samples', row => {
    const { includeSelf, entries, samples } = row;
    const result = methods.subtreeSamples(createMetrics(), 'a', includeSelf);
    const { mask, sampleSelector } = result;
    const masked = [];

    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 1) {
            masked.push(i);
        }
    }

    assert.deepEqual(result.entries, entries);
    assert.deepEqual([...result.selectedSamples], samples);
    assert.deepEqual(masked, samples);
    assert.deepEqual([0, 1, 2, 3, 4, 5].filter(sample => sampleSelector(null, sample)), samples);
});

test.each([
    ['b', {
        nodeIndex: 2,
        samples: 2,
        selfValue: 30,
        nestedValue: 40,
        totalValue: 70
    }],
    [4, {
        nodeIndex: 4,
        samples: 1,
        selfValue: 50,
        nestedValue: 0,
        totalValue: 50
    }]
])('getMetrics(%o) gives the metrics of the index of the subject', (subject, expectedMetrics) => {
    const { nodeIndex, ...expected } = expectedMetrics;
    const { node, ...actual } = methods.getMetrics(createMetrics(), subject);

    assert.equal(node.nodeIndex, nodeIndex);
    assert.deepEqual(actual, expected);
});

// Node 2 has two samples; the recursive a in it is excluded
test('nestedValues() sums self values of nodes nested in the subject once per node, by entry', () => {
    const metrics = createMetrics();

    assert.deepEqual(methods.nestedValues(metrics, 'a'), [{ entry: 'b', selfValue: 30 }]);
    assert.deepEqual(methods.nestedValues(metrics, 1, metrics.tree), [{ entry: 'b', selfValue: 30 }]);
});
