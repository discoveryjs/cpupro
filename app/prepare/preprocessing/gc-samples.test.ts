import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfile } from '../profile.mjs';
import { noopWorkHandler } from '../misc/work.js';
import type { V8CpuProfile } from '../types.js';

function createProfileData(scriptId: (id: number) => number | string): V8CpuProfile {
    const createNode = (id: number, functionName: string, nodeScriptId: number, children?: number[]) => ({
        id,
        children,
        callFrame: {
            scriptId: scriptId(nodeScriptId),
            url: nodeScriptId !== 0 ? 'app.js' : '',
            functionName,
            lineNumber: nodeScriptId !== 0 ? 0 : -1,
            columnNumber: nodeScriptId !== 0 ? 9 : -1
        }
    });

    return {
        startTime: 0,
        endTime: 50,
        nodes: [
            createNode(1, '(root)', 0, [2, 3, 4]),
            createNode(2, 'work', 7),
            createNode(3, '(garbage collector)', 0),
            createNode(4, '(program)', 0)
        ],
        samples: [2, 3, 2, 4, 3],
        timeDeltas: [10, 10, 10, 10, 10]
    };
}

// Call frame names of each sample's call stack, from the innermost one
async function sampleStacks(data: V8CpuProfile) {
    const profile = await createProfile(data, { work: noopWorkHandler });
    const { population, source } = profile.timeline!.breakdowns[0];
    const { parent, nodes, dictionary, sourceIdToNode } = source;
    const stacks: string[][] = [];

    for (let i = 0; i < population.samples.length; i++) {
        const stack: string[] = [];

        // node 0 is the root
        for (let j = sourceIdToNode[population.samples[i]]; j !== 0; j = parent[j]) {
            const entry = dictionary[nodes[j]];
            const name = 'callFrame' in entry
                ? entry.callFrame.name
                : entry.name;

            stack.push(name);
        }

        stacks.push(stack);
    }

    return stacks;
}

test('attaches GC samples to the call stack of the previous sample, for numeric and string script ids', async () => {
    const numericId = (id: number) => id;
    const stringId = (id: number) => String(id);
    const expected = [
        ['work'],
        ['(garbage collector)', 'work'],
        ['work'],
        ['(program)'],
        ['(garbage collector)', '(program)']
    ];

    assert.deepEqual(await sampleStacks(createProfileData(numericId)), expected);
    assert.deepEqual(await sampleStacks(createProfileData(stringId)), expected);
});

test.each([
    { name: 'children', givesParent: false },
    // Profiles of traces give nodes a parent instead of children
    { name: 'a parent', givesParent: true }
])('attaches GC samples to nested call stacks when nodes give $name', async row => {
    const relation = (children: number[], parent?: number) => row.givesParent
        ? { parent }
        : { children };
    const data = createProfileData(id => id);
    const [root, work, gc, program] = data.nodes;
    const innerCallFrame = { ...work.callFrame, functionName: 'inner' };
    const nodes = [
        {
            id: root.id,
            callFrame: root.callFrame,
            ...relation([2, 3, 4])
        },
        {
            id: work.id,
            callFrame: work.callFrame,
            ...relation([5], 1)
        },
        {
            id: gc.id,
            callFrame: gc.callFrame,
            ...relation([], 1)
        },
        {
            id: program.id,
            callFrame: program.callFrame,
            ...relation([], 1)
        },
        {
            id: 5,
            callFrame: innerCallFrame,
            ...relation([], 2)
        }
    ];

    const nestedData = {
        ...data,
        nodes,
        samples: [5, 3, 2, 4, 3]
    };

    assert.deepEqual(await sampleStacks(nestedData), [
        ['inner', 'work'],
        ['(garbage collector)', 'inner', 'work'],
        ['work'],
        ['(program)'],
        ['(garbage collector)', '(program)']
    ]);
});
