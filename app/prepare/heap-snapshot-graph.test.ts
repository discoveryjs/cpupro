import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
    NO_NODE,
    computeDistances,
    computeDominatorTree,
    computeFirstEdges,
    computeRetainers,
    edgeOwner
} from './heap-snapshot-graph.js';
import { sequence } from '../../test/helpers/values.js';

const WEAK = 6;
const STRONG = 2;

// A graph by the targets of every node's edges, each edge strong unless listed as weak by [source, target]
function createGraph(targets: number[][], weak: [number, number][] = []) {
    const toNodes: number[] = [];
    const edgeTypes: number[] = [];

    for (let i = 0; i < targets.length; i++) {
        for (let j = 0; j < targets[i].length; j++) {
            const isWeak = weak.some(([source, target]) => source === i && target === targets[i][j]);

            toNodes.push(targets[i][j]);
            edgeTypes.push(isWeak ? WEAK : STRONG);
        }
    }

    return {
        firstEdges: computeFirstEdges(targets.map(nodeTargets => nodeTargets.length), targets.length),
        toNodes: new Uint32Array(toNodes),
        edgeTypes: new Uint8Array(edgeTypes)
    };
}

// The immediate dominator by definition: the dominator of a node every other dominator dominates, found as the
// nearest node on a path from the root that cuts the node off the root
function dominatorsByDefinition(targets: number[][], edgeTypes: Uint8Array, firstEdges: Uint32Array) {
    const reachable = (removed: number) => {
        const seen = new Uint8Array(targets.length);
        const stack = removed === 0 ? [] : [0];

        if (removed !== 0) {
            seen[0] = 1;
        }

        while (stack.length > 0) {
            const node = stack.pop()!;

            for (let i = 0; i < targets[node].length; i++) {
                const target = targets[node][i];

                if (edgeTypes[firstEdges[node] + i] !== WEAK && target !== removed && seen[target] === 0) {
                    seen[target] = 1;
                    stack.push(target);
                }
            }
        }

        return seen;
    };
    const reached = reachable(-1);
    const dominatorSets = targets.map((_, node) => {
        const set: number[] = [];

        for (let i = 0; i < targets.length; i++) {
            if (i !== node && reached[node] === 1 && reachable(i)[node] === 0) {
                set.push(i);
            }
        }

        return set;
    });

    return dominatorSets.map((set, node) => {
        if (node === 0 || reached[node] === 0) {
            return NO_NODE;
        }

        // the immediate dominator is the dominator with the most dominators of its own
        let immediate = set[0];

        for (let i = 1; i < set.length; i++) {
            if (dominatorSets[set[i]].length > dominatorSets[immediate].length) {
                immediate = set[i];
            }
        }

        return immediate;
    });
}

test('first edges of nodes and retainers of nodes in the order of their owners', () => {
    const { firstEdges, toNodes } = createGraph([[1, 2], [2], [1, 0], []]);
    const { firstRetainers, retainerEdges } = computeRetainers(toNodes, 4);

    assert.deepEqual(firstEdges, new Uint32Array([0, 2, 3, 5, 5]));
    assert.deepEqual(firstRetainers, new Uint32Array([0, 1, 3, 5, 5]));
    assert.deepEqual(retainerEdges, new Uint32Array([4, 0, 3, 1, 2]));
    assert.deepEqual([0, 1, 2, 3, 4].map(edge => edgeOwner(firstEdges, edge)), [0, 0, 1, 2, 2]);
});

// 0 → 1, 2; 1, 2 → 3 (a diamond); 3 → 4; 0 ⇢ 5 weak, 4 → 5; 6 out of reach holds 4
test('the dominator tree takes strong edges, nodes out of reach retain themselves', () => {
    const { firstEdges, toNodes, edgeTypes } = createGraph(
        [[1, 2, 5], [3], [3], [4], [5], [], [4]],
        [[0, 5]]
    );
    const selfSizes = [1, 2, 4, 8, 16, 32, 64];
    const { dominators, retainedSizes } = computeDominatorTree(firstEdges, toNodes, edgeTypes, WEAK, selfSizes);

    assert.deepEqual(dominators, new Uint32Array([NO_NODE, 0, 0, 0, 3, 4, NO_NODE]));
    assert.deepEqual(retainedSizes, new Float64Array([63, 2, 4, 56, 48, 32, 64]));
    assert.deepEqual(
        computeDistances(firstEdges, toNodes, edgeTypes, WEAK),
        new Uint32Array([0, 1, 1, 2, 3, 4, NO_NODE])
    );
});

test('the dominator tree of random graphs is the one by definition', () => {
    const random = sequence(7);

    for (let graph = 0; graph < 30; graph++) {
        const nodeCount = 2 + random(40);
        const targets: number[][] = [];
        const weak: [number, number][] = [];

        for (let i = 0; i < nodeCount; i++) {
            const edgeCount = random(4);

            targets.push([]);

            for (let j = 0; j < edgeCount; j++) {
                const target = random(nodeCount);

                targets[i].push(target);

                if (random(5) === 0) {
                    weak.push([i, target]);
                }
            }
        }

        const { firstEdges, toNodes, edgeTypes } = createGraph(targets, weak);
        const selfSizes = targets.map(() => 1 + random(100));
        const { dominators, retainedSizes } = computeDominatorTree(firstEdges, toNodes, edgeTypes, WEAK, selfSizes);
        const expected = dominatorsByDefinition(targets, edgeTypes, firstEdges);

        assert.deepEqual(Array.from(dominators), expected, `graph ${graph}`);

        // a node's retained size is the self sizes of the nodes it dominates, itself included
        for (let i = 0; i < nodeCount; i++) {
            let retained = 0;

            for (let j = 0; j < nodeCount; j++) {
                let dominator = j;

                while (dominator !== NO_NODE && dominator !== i) {
                    dominator = expected[dominator];
                }

                if (dominator === i) {
                    retained += selfSizes[j];
                }
            }

            assert.equal(retainedSizes[i], retained, `graph ${graph}, node ${i}`);
        }
    }
});
